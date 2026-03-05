import { Page } from 'puppeteer';
import { ScrapeError } from '../error/ScrapeError';
import { delay, promisePool } from '../util/promise';
import { Book } from './Book';
import { defDownloadOptions, DownloadOptions } from './download-options';
import { getPdfOptions } from './get-pdf-options';

export class ScookBook extends Book {
  async download(outDir: string, _options?: DownloadOptions) {
    const saveDir = await this.mkSubDir(outDir);
    const options = defDownloadOptions(_options);
    await this.mkTempDir();

    // Get book frame url
    let bookFrameUrl: string;

    const userPage = await this.shelf.browser.newPage();
    try {
      // Intercept JSON responses — some scook versions fetch the viewer URL via API
      let interceptedUrl: string | null = null;
      userPage.on('response', async (response) => {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const json = await response.json();
          const candidate =
            json?.viewerUrl || json?.iframeUrl || json?.url ||
            json?.bookUrl || json?.readerUrl ||
            json?.data?.viewerUrl || json?.data?.url;
          if (typeof candidate === 'string' && candidate.startsWith('http') && !interceptedUrl) {
            interceptedUrl = candidate;
          }
        } catch { /* ignore */ }
      });

      await userPage.goto(this.url, {
        waitUntil: 'load',
        timeout: this.shelf.options.timeout,
      });

      // Wait for the unity-veritas component to initialize and render its contents
      try {
        await userPage.waitForFunction(
          () => {
            // Check for iframe anywhere on page
            const iframe = document.querySelector('iframe[src]');
            if (iframe) return true;
            // Or wait for the component div to have rendered children
            const comp = document.querySelector('.unity-veritas-product-viewer-component');
            return comp ? comp.children.length > 0 : false;
          },
          { timeout: 60000, polling: 1000 }
        );
      } catch { /* timed out — will fail below with useful error */ }

      // Try to find iframe (including inside shadow DOM via all iframes)
      let viewerUrl: string | null = interceptedUrl;
      if (!viewerUrl) {
        viewerUrl = await userPage.evaluate(() => {
          const iframe = document.querySelector<HTMLIFrameElement>('iframe[src]');
          return iframe?.src ?? null;
        });
      }

      // If no iframe found, the page may be on the wrong section — try the E-Book section
      if (!viewerUrl) {
        const productId = await userPage.evaluate(() => {
          const el = document.querySelector('[data-context]');
          if (!el) return null;
          try {
            return JSON.parse(el.getAttribute('data-context') ?? '{}')?.productId ?? null;
          } catch { return null; }
        });

        if (productId) {
          const ebookUrl = `https://www.scook.at/produkt/${productId}?section=E-Book`;
          await userPage.goto(ebookUrl, {
            waitUntil: 'load',
            timeout: this.shelf.options.timeout,
          });
          try {
            await userPage.waitForFunction(
              () => !!document.querySelector('iframe[src]') ||
                (document.querySelector('.unity-veritas-product-viewer-component')?.children.length ?? 0) > 0,
              { timeout: 60000, polling: 1000 }
            );
          } catch { /* will fail below */ }

          viewerUrl = await userPage.evaluate(() =>
            document.querySelector<HTMLIFrameElement>('iframe[src]')?.src ?? null
          );
        }
      }

      if (!viewerUrl) {
        const finalUrl = userPage.url();
        const html = await userPage.evaluate(() => document.body?.innerHTML ?? '');
        throw new ScrapeError(
          `Could not find book iframe on scook page "${this.title}". ` +
            `Final URL: ${finalUrl}\nPage body (first 2000 chars): ${html.slice(0, 2000)}`
        );
      }

      bookFrameUrl = viewerUrl;
    } finally {
      await userPage.close().catch(() => {});
    }

    const framePage = await this.shelf.browser.newPage();
    try {
      await framePage.goto(bookFrameUrl, {
        waitUntil: 'load',
        timeout: this.shelf.options.timeout,
      });

      const pageUrls = await this.getPageUrls(framePage);

      let downloadedPages = 0;
      const getProgress = () => ({
        item: this,
        percentage: downloadedPages / pageUrls.length,
        downloadedPages,
        pageCount: pageUrls.length,
      });
      options.onStart(getProgress());

      await promisePool(
        async (i) => {
          const pageNo = i + 1;
          await this.savePage(pageUrls[i], saveDir, pageNo, options);

          downloadedPages++;
          options.onProgress(getProgress());
        },
        options.concurrency,
        pageUrls.length
      );

      // Merge pdf pages
      options.mergePdfs && (await this.mergePdfPages(saveDir, pageUrls.length));
    } finally {
      await framePage.close();
    }
  }

  private async getPageUrls(framePage: Page) {
    // get count
    let pageCount: number;
    while (true) {
      try {
        pageCount = parseInt(
          await framePage.$eval(
            '#total-pages',
            (totalPages) => (totalPages as HTMLSpanElement).innerText
          )
        );
      } catch (e) {
        await delay(1000);
        continue;
      }
      if (isNaN(pageCount)) continue;
      break;
    }

    const goPageForm = await framePage.$('form.go-page');
    if (!goPageForm) {
      throw new ScrapeError('Could not locate scooks go page form.');
    }
    const curPageInput = await framePage.$('input.current-page');
    if (!curPageInput) {
      throw new ScrapeError('Could not locate scooks current page input.');
    }

    let pageUrls: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      const pageNo = i + 1;

      // nav to page
      await curPageInput.type(pageNo.toString());
      await curPageInput.press('Enter');

      // get page
      const img = await framePage.$('.image-div > img');
      if (!img) {
        throw new ScrapeError('Could not locate scook book page image.');
      }
      const pageUrl = await img.evaluate(
        (img) => (img as HTMLImageElement).src
      );
      pageUrls.push(pageUrl);
    }

    return pageUrls;
  }

  private async savePage(
    pageUrl: string,
    saveDir: string,
    pageNo: number,
    options: DownloadOptions
  ) {
    const page = await this.shelf.browser.newPage();
    try {
      await page.goto(pageUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.shelf.options.timeout,
      });

      // Save as pdf via temp dir (ASCII path, avoids muhammara Unicode/long-path issues)
      const pdfFile = this.getTempPdfPath(pageNo);

      await page.pdf({
        ...(await getPdfOptions(page, options)),
        path: pdfFile,
      });
    } finally {
      await page.close();
    }
  }
}
