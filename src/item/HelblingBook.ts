import { ScrapeError } from '../error/ScrapeError';
import { promisePool } from '../util/promise';
import { Book } from './Book';
import { defDownloadOptions, DownloadOptions } from './download-options';
import { getPdfOptions } from './get-pdf-options';

export class HelblingBook extends Book {
  async download(outDir: string, _options?: DownloadOptions) {
    const dir = await this.mkSubDir(outDir);
    const options = defDownloadOptions(_options);
    await this.mkTempDir();

    // Build per-page URL: hash fragment contains ?page=N
    const [baseUrl, hashPart] = this.url.split('#');
    const hashBase = hashPart?.replace(/[?&]page=\d+.*$/, '') ?? '';
    const getPageUrl = (pageIndex: number) =>
      `${baseUrl}#${hashBase}?page=${pageIndex}`;

    // Load first page; intercept API responses to detect total page count
    let pageCount = 0;
    const setupPage = await this.shelf.browser.newPage();
    try {
      setupPage.on('response', async (response) => {
        try {
          const ct = response.headers()['content-type'] ?? '';
          if (!ct.includes('json')) return;
          const json = await response.json();
          // book.json has pages as an array; other APIs may use numeric fields
          const count =
            (Array.isArray(json?.pages) ? json.pages.length : 0) ||
            json?.pageCount ||
            json?.total_pages ||
            json?.numPages ||
            json?.totalPages ||
            json?.data?.pages?.length ||
            json?.data?.pageCount;
          if (typeof count === 'number' && count > 0 && count > pageCount) {
            pageCount = count;
          }
        } catch {
          /* not JSON or already consumed */
        }
      });

      await setupPage.goto(getPageUrl(0), {
        waitUntil: 'networkidle2',
        timeout: this.shelf.options.timeout,
      });

      // Fallback: scrape page counter from DOM (e.g. "1 / 250" or "1 of 250")
      if (!pageCount) {
        const domText = await setupPage.evaluate(() => document.body?.innerText ?? '');
        const m = domText.match(/\d+\s*(?:\/|of)\s*(\d+)/);
        pageCount = m ? parseInt(m[1], 10) : 0;
      }

      if (!pageCount) {
        throw new ScrapeError(
          `Could not determine page count for Helbling book "${this.title}". ` +
            `Please report this issue.`
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
        const page = await this.shelf.browser.newPage();
        try {
          await page.goto(getPageUrl(i), {
            waitUntil: 'networkidle2',
            timeout: this.shelf.options.timeout,
          });

          const pdfFile = this.getTempPdfPath(i + 1);
          await page.pdf({
            ...(await getPdfOptions(page, options)),
            path: pdfFile,
          });

          downloadedPages++;
          options.onProgress(getProgress());
        } finally {
          await page.close().catch(() => {});
        }
      },
      options.concurrency,
      pageCount
    );

    options.mergePdfs && (await this.mergePdfPages(dir, pageCount));
  }
}
