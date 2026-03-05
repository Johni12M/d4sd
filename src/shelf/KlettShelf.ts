import { ScrapeError } from '../error/ScrapeError';
import { LoginError } from '../error/LoginError';
import { ItemRef } from '../item/ItemRef';
import { InitOptions, Shelf } from './Shelf';

export class KlettShelf extends Shelf {
  static id = 'klett';

  constructor() {
    super('https://bridge.klett.de');
  }

  static async load(options: InitOptions) {
    return await new KlettShelf().init(options);
  }

  protected async login() {
    const page = await this.browser.newPage();
    try {
      // Navigate to OAuth2 endpoint — Keycloak login form loads at id.klett.de
      await page.goto(
        new URL('/oauth2/authorization/keycloak-ekv', this.origin).toString(),
        { waitUntil: 'networkidle2', timeout: this.options.timeout }
      );

      // Wait for login form fields
      await page.waitForFunction(
        () =>
          document.querySelector('#username') !== null &&
          document.querySelector('#password') !== null &&
          document.querySelector('#kc-login') !== null,
        { timeout: this.options.timeout }
      );

      await page.type('#username', this.options.user);
      await page.type('#password', this.options.password);
      await page.click('#kc-login');

      // OAuth2 involves multiple redirects; poll until we land on bridge.klett.de
      // or an error appears
      await Promise.race([
        page.waitForFunction(
          () => location.hostname === 'bridge.klett.de' && !location.pathname.startsWith('/login/oauth2'),
          { timeout: this.options.timeout, polling: 500 }
        ),
        page.waitForFunction(
          () => document.querySelector('#input-error, .pf-c-alert, .alert-error') !== null,
          { timeout: this.options.timeout }
        ).then(() => { throw new LoginError('Login to https://bridge.klett.de failed.'); }),
      ]);
    } finally {
      await page.close();
    }
  }

  async getItems(): Promise<ItemRef[]> {
    const page = await this.browser.newPage();
    try {
      // Navigate to the bookshelf/dashboard page
      await page.goto(new URL('/shelf', this.origin).toString(), {
        waitUntil: 'networkidle2',
        timeout: this.options.timeout,
      });

      // If /shelf doesn't work, try root or /books
      const currentUrl = page.url();
      if (!currentUrl.includes('bridge.klett.de') || currentUrl.includes('login')) {
        await page.goto(this.origin, {
          waitUntil: 'networkidle2',
          timeout: this.options.timeout,
        });
      }

      // Scrape all book links from the shelf
      const items = await page.evaluate((origin) => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
        const seen = new Set<string>();
        const results: { url: string; title: string }[] = [];

        for (const a of anchors) {
          const href = a.href;
          // Book URLs match the pattern: bridge.klett.de/{slug}/
          if (!href.startsWith(origin) || href === origin + '/') continue;
          const path = new URL(href).pathname;
          // Must be a direct sub-path (one segment), not a utility page
          const segments = path.replace(/^\/|\/$/g, '').split('/');
          if (segments.length !== 1 || !segments[0]) continue;

          if (seen.has(href)) continue;
          seen.add(href);

          const title =
            a.querySelector('h1, h2, h3, [class*="title"]')?.textContent?.trim() ||
            a.getAttribute('title') ||
            a.getAttribute('aria-label') ||
            a.textContent?.trim() ||
            segments[0];

          results.push({ url: href, title });
        }

        return results;
      }, this.origin);

      if (!items.length) {
        throw new ScrapeError(
          'Could not find any books on the Klett shelf. ' +
            'Try specifying book URLs directly instead of listing the shelf.'
        );
      }

      return items.map((item) => new ItemRef(this, item.url, item.title));
    } finally {
      await page.close();
    }
  }
}
