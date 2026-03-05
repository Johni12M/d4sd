import { delay, promisePool } from '../util/promise';
import { waitForGoto } from '../util/puppeteer';
import { URL } from 'url';
import { Book } from './Book';
import { defDownloadOptions, DownloadOptions } from './download-options';
import { SizeAttributes, getPdfOptions } from './get-pdf-options';
import { ScrapeError } from '../error/ScrapeError';
import muhammara from 'muhammara';

class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private limit: number) {}

  async acquire() {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release() {
    this.running--;
    this.queue.shift()?.();
  }
}

export class DigiBook extends Book {
  async download(outDir: string, _options?: DownloadOptions) {
    const dir = await this.mkSubDir(outDir);
    const tmpDir = await this.mkTempDir();
    const options = defDownloadOptions(_options);

    // Get url of 1st svg page
    const checkPage = await this.shelf.browser.newPage();
    let page1Url: string;
    let sizeHint: SizeAttributes;
    let pageCount: number;
    try {
      await checkPage.goto(new URL(`?page=1`, this.url).toString(), {
        waitUntil: 'networkidle2',
        timeout: this.shelf.options.timeout,
      });
      [page1Url, sizeHint] = await checkPage.$eval(
        '#pg1 > object',
        (obj: HTMLObjectElement): [string, SizeAttributes] => [
          obj.data,
          { width: obj.width, height: obj.height },
        ]
      );
      pageCount = await checkPage.$$eval(
        '#thumbnailPanel a.thumbnail',
        (elms) => elms.length
      );
    } finally {
      await checkPage.close();
    }

    // Page download pool — semaphore limits concurrent PDF exports to avoid
    // Chromium renderer corruption when many tabs export simultaneously
    const pdfSemaphore = new Semaphore(3);
    let downloadedPages = 0;
    const getProgress = () => ({
      item: this,
      percentage: downloadedPages / pageCount,
      downloadedPages,
      pageCount,
    });
    options.onStart(getProgress());

    await promisePool(async (i, stop) => {
      const pageNo = i + 1;

      const page = await this.shelf.browser.newPage();
      try {
        // Go to current svg page
        const base = this.url.replace(/(?<=\/)[^\/]+$/g, '');
        const pageUrl = new URL(
          page1Url
            .slice(base.length)
            .replace(/(?<=\/|^)1(?=\/|\.|$)/gm, pageNo.toString()),
          base
        ).toString();
        const res = await waitForGoto(
          page,
          await page.goto(pageUrl, {
            waitUntil: 'networkidle0',
            timeout: this.shelf.options.timeout,
          })
        );
        if (!res.ok()) return stop();

        // Save it as pdf via temp dir (ASCII path, avoids muhammara Unicode/long-path issues)
        const tmpFile = this.getTempPdfPath(pageNo);
        let valid = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            await delay(1000 * attempt);
            await page.reload({
              waitUntil: 'networkidle0',
              timeout: this.shelf.options.timeout,
            });
          }

          await pdfSemaphore.acquire();
          try {
            await page.pdf({
              ...(await getPdfOptions(page, options, sizeHint)),
              path: tmpFile,
            });
          } finally {
            pdfSemaphore.release();
          }

          try {
            const reader = muhammara.createReader(tmpFile);
            if (reader.getPagesCount() >= 1) {
              valid = true;
              break;
            }
          } catch {}
        }

        if (!valid) {
          throw new ScrapeError(
            `Page ${pageNo} of "${this.title}" consistently produced an invalid PDF.`
          );
        }

        downloadedPages++;
        options.onProgress(getProgress());
      } finally {
        await page.close();
      }
    }, options.concurrency);

    if (downloadedPages != pageCount) {
      throw new ScrapeError(
        `A page count of ${pageCount} was parsed, but ${downloadedPages} were downloaded. Please report this issue.`
      );
    }

    // Merge pdf pages
    options.mergePdfs && (await this.mergePdfPages(dir, downloadedPages));
  }
}
