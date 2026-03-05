import { Shelf } from '../shelf/Shelf';
import { Archive } from './Archive';
import { BiBoxBook } from './BiBoxBook';
import { DigiBook } from './DigiBook';
import { HelblingBook } from './HelblingBook';
import { Item } from './Item';
import { MarklBook } from './MarklBook';
import { OebvBook } from './OebvBook';
import { ScookBook } from './ScookBook';

export class ItemRef {
  constructor(
    public shelf: Shelf,
    public url: string,
    public title: string
  ) {}

  async resolve(): Promise<Item | null> {
    const page = await this.shelf.browser.newPage();
    try {
      const resolveTimeout = Math.min(this.shelf.options.timeout, 15000);
      try {
        await page.goto(this.url, {
          waitUntil: 'domcontentloaded',
          timeout: resolveTimeout,
        });
      } catch {
        // TimeoutError is fine — redirects already happened, check URL anyway
      }

      // Wait briefly for JS-based redirects (e.g. digi4school → helbling)
      try {
        await page.waitForNavigation({
          waitUntil: 'domcontentloaded',
          timeout: 5000,
        });
      } catch {
        // No redirect happened, continue with current URL
      }

      const pageUrl = page.url();

      if (pageUrl.includes('service.helbling.com')) {
        return new HelblingBook(this.shelf, pageUrl, this.title);
      }

      if (pageUrl.includes('bridge.klett.de')) {
        return new MarklBook(this.shelf, pageUrl, this.title);
      }

      if (pageUrl.includes('scook.at')) {
        return new ScookBook(this.shelf, pageUrl, this.title);
      }

      if (pageUrl.includes('bibox2.westermann.de')) {
        return new BiBoxBook(this.shelf, pageUrl, this.title);
      }

      if (pageUrl.includes('portal.oebv.at')) {
        return new OebvBook(this.shelf, pageUrl, this.title);
      }

      // DOM checks wrapped in try-catch — page may be in bad state after timeout
      try {
        if ((await page.$('#loadPage')) != null) {
          return new DigiBook(this.shelf, pageUrl, this.title);
        }

        if (
          await page.$$eval('script', (scripts) =>
            scripts.some((script) =>
              (script as HTMLScriptElement).src.includes('/ce.js')
            )
          )
        ) {
          return new Archive(this.shelf, pageUrl, this.title);
        }
      } catch {
        // Page context may be broken after navigation timeout
      }

      return null;
    } finally {
      await page.close();
    }
  }
}
