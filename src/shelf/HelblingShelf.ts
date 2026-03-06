import { LoginError } from '../error/LoginError';
import { ItemRef } from '..';
import { InitOptions, Shelf } from './Shelf';

export class HelblingShelf extends Shelf {
  static id = 'helbling';

  constructor() {
    super('https://helbling.at/');
    this.origins.push('https://service.helbling.com/');
  }

  static async load(options: InitOptions) {
    return await new HelblingShelf().init(options);
  }

  protected async login() {
    const page = await this.browser.newPage();
    try {
      await page.goto(new URL('/login', this.origin).toString(), {
        waitUntil: 'networkidle2',
        timeout: this.options.timeout,
      });

      const emailField =
        (await page.$('input[type="email"]')) ??
        (await page.$('input[name="email"]')) ??
        (await page.$('input[name="username"]'));

      const passwordField = await page.$('input[type="password"]');

      const submitBtn =
        (await page.$('button[type="submit"]')) ??
        (await page.$('input[type="submit"]'));

      if (!emailField || !passwordField || !submitBtn) {
        throw new LoginError(
          'Could not find login form on Helbling. ' +
            'The login page structure may have changed — please report this.'
        );
      }

      await emailField.type(this.options.user);
      await passwordField.type(this.options.password);
      await submitBtn.click();

      const success = await Promise.race([
        page
          .waitForNavigation({ timeout: this.options.timeout })
          .then(() => true),
        page
          .waitForFunction(
            () =>
              document.querySelector(
                '.error, .alert-error, [class*="error"]'
              ) !== null,
            { timeout: this.options.timeout }
          )
          .then(() => false),
      ]);

      if (!success) {
        throw new LoginError('Login to Helbling failed.');
      }
    } finally {
      await page.close();
    }
  }

  // Helbling does not support automatic book listing.
  // Provide book URLs directly when running the downloader.
  async getItems(): Promise<ItemRef[]> {
    return [];
  }
}
