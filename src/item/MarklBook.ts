import { ScrapeError } from '../error/ScrapeError';
import { delay, promisePool } from '../util/promise';
import { Book } from './Book';
import { defDownloadOptions, DownloadOptions } from './download-options';
import { getPdfOptions } from './get-pdf-options';
import type { Page } from 'puppeteer';

/** Inject script to uncheck the welcome-modal toggle before any page scripts run. */
async function injectModalAutoDismiss(page: Page) {
  await page.evaluateOnNewDocument(() => {
    const dismiss = () => {
      const checkbox = document.getElementById('toggle-window-welcome') as HTMLInputElement | null;
      if (checkbox && checkbox.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Belt-and-suspenders: also click the close label
      const label = document.querySelector<HTMLElement>('label[for="toggle-window-welcome"].close, label.close[for="toggle-window-welcome"]');
      if (label) label.click();
    };
    // Run immediately when DOM is ready and on any DOM mutation
    document.addEventListener('DOMContentLoaded', dismiss);
    new MutationObserver(dismiss).observe(document.documentElement, { childList: true, subtree: true });
  });
}

/** Dismiss any lingering welcome modal on an already-loaded page. */
async function dismissModalAndWait(page: Page) {
  await page.evaluate(() => {
    const checkbox = document.getElementById('toggle-window-welcome') as HTMLInputElement | null;
    if (checkbox && checkbox.checked) {
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const label = document.querySelector<HTMLElement>('label[for="toggle-window-welcome"]');
    if (label) label.click();
  });
  await delay(300);
}

export class MarklBook extends Book {
  async download(outDir: string, _options?: DownloadOptions) {
    const dir = await this.mkSubDir(outDir);
    const options = defDownloadOptions(_options);
    await this.mkTempDir();

    // URL pattern: https://bridge.klett.de/{book-id}/?page={pageNo} (1-indexed)
    const baseUrl = this.url.replace(/([?&]page=\d+).*$/, '').replace(/\/?$/, '/');
    const getPageUrl = (pageNo: number) => `${baseUrl}?page=${pageNo}`;

    // Load first page; intercept JSON responses to detect total page count
    let pageCount = 0;
    const setupPage = await this.shelf.browser.newPage();
    try {
      await injectModalAutoDismiss(setupPage);
      setupPage.on('response', async (response) => {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const json = await response.json();
          const count =
            (Array.isArray(json?.pages) ? json.pages.length : 0) ||
            json?.pageCount ||
            json?.page_count ||
            json?.total_pages ||
            json?.totalPages ||
            json?.numPages ||
            json?.data?.pageCount ||
            json?.data?.total_pages;
          if (typeof count === 'number' && count > 0 && count > pageCount) {
            pageCount = count;
          }
        } catch {
          /* not JSON or already consumed */
        }
      });

      await setupPage.goto(getPageUrl(1), {
        waitUntil: 'load',
        timeout: this.shelf.options.timeout,
      });
      await delay(3000); // let SPA render
      await dismissModalAndWait(setupPage);
      await delay(1000); // wait after modal dismiss

      // Fallback 1: scrape page counter from DOM (e.g. "1 / 200" or "1 von 200")
      if (!pageCount) {
        const domText = await setupPage.evaluate(() => document.body?.innerText ?? '');
        const m = domText.match(/\b(\d+)\s*(?:\/|of|von)\s*(\d+)\b/);
        if (m) pageCount = parseInt(m[2], 10);
      }

      // Fallback 2: look for max on a number input or a data attribute
      if (!pageCount) {
        pageCount = await setupPage.evaluate(() => {
          const el =
            document.querySelector<HTMLInputElement>('input[type="number"]') ??
            document.querySelector('[data-page-count]') ??
            document.querySelector('[data-total-pages]') ??
            document.querySelector('[data-max-page]') ??
            document.querySelector('[data-pages]');
          if (!el) return 0;
          const val =
            (el as HTMLInputElement).max ||
            el.getAttribute('data-page-count') ||
            el.getAttribute('data-total-pages') ||
            el.getAttribute('data-max-page') ||
            el.getAttribute('data-pages');
          return val ? parseInt(val, 10) : 0;
        });
      }

      // Fallback 3: scan JS window state for a page count value
      if (!pageCount) {
        pageCount = await setupPage.evaluate(() => {
          const w = window as unknown as Record<string, unknown>;
          const candidates = [
            'pageCount', 'page_count', 'totalPages', 'total_pages',
            'numPages', 'numSeiten', 'pageTotal',
          ];
          const search = (obj: unknown, depth = 0): number => {
            if (depth > 4 || obj === null || typeof obj !== 'object') return 0;
            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
              if (candidates.includes(k) && typeof v === 'number' && v > 0) return v;
              const r = search(v, depth + 1);
              if (r > 0) return r;
            }
            return 0;
          };
          for (const key of candidates) {
            if (typeof w[key] === 'number' && (w[key] as number) > 0) return w[key] as number;
          }
          // Try common state containers
          for (const key of ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', 'APP_STATE', '__APP__']) {
            if (w[key]) {
              const r = search(w[key]);
              if (r > 0) return r;
            }
          }
          return 0;
        });
      }

      // Fallback 4: binary search - probe pages until one fails
      if (!pageCount) {
        const isValidPage = async (n: number) => {
          const probe = await this.shelf.browser.newPage();
          try {
            const resp = await probe.goto(getPageUrl(n), {
              waitUntil: 'domcontentloaded',
              timeout: 15000,
            });
            if (!resp || resp.status() === 404) return false;
            // If page redirects back to page 1, it's out of range
            const finalUrl = probe.url();
            if (finalUrl.includes('page=1') && n !== 1) return false;
            return true;
          } catch {
            return false;
          } finally {
            await probe.close().catch(() => {});
          }
        };
        // Exponential probe to find upper bound
        let lo = 1, hi = 1;
        while (await isValidPage(hi)) hi *= 2;
        // Binary search between lo and hi
        while (lo < hi - 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (await isValidPage(mid)) lo = mid;
          else hi = mid;
        }
        if (lo > 1) pageCount = lo;
      }

      if (!pageCount && options.pageCount) {
        pageCount = options.pageCount;
      }

      if (!pageCount) {
        throw new ScrapeError(
          `Could not determine page count for Markl book "${this.title}". ` +
            `Please report this issue, or supply --page-count manually.`
        );
      }
    } finally {
      await setupPage.close().catch(() => {});
    }

    // Download all pages
    let downloadedPages = 0;
    const getProgress = () => ({
      item: this,
      percentage: downloadedPages / pageCount,
      downloadedPages,
      pageCount,
    });
    options.onStart(getProgress());

    await promisePool(
      async (i) => {
        const pageNo = i + 1;
        let lastErr: unknown;
        for (let attempt = 0; attempt < 3; attempt++) {
          const page = await this.shelf.browser.newPage();
          try {
            await injectModalAutoDismiss(page);
            await page.goto(getPageUrl(pageNo), {
              waitUntil: 'networkidle2',
              timeout: this.shelf.options.timeout,
            });
            await dismissModalAndWait(page);
            await delay(1500); // let book page image render after modal clears

            const pdfFile = this.getTempPdfPath(pageNo);
            await page.pdf({
              ...(await getPdfOptions(page, options)),
              path: pdfFile,
            });

            downloadedPages++;
            options.onProgress(getProgress());
            return;
          } catch (e) {
            lastErr = e;
            await delay(1000 * (attempt + 1));
          } finally {
            await page.close().catch(() => {});
          }
        }
        console.error(`Failed to download page ${pageNo} after 3 attempts:`, lastErr);
      },
      options.concurrency,
      pageCount
    );

    options.mergePdfs && (await this.mergePdfPages(dir, pageCount));
  }
}
