#!/usr/bin/env node

import './config/env';

import {
  command,
  boolean,
  flag,
  number,
  option,
  optional,
  restPositionals,
  run,
  string,
} from 'cmd-ts';
import { Shelf } from './shelf/Shelf';
import inquirer from 'inquirer';
import { minimatch } from 'minimatch';
import { PaperFormat } from 'puppeteer';
// @ts-ignore
import { paperFormats } from 'puppeteer';
import { hasOwnProperty } from './util/object';
import { ScookShelf } from './shelf/ScookShelf';
import { DigiShelf } from './shelf/DigiShelf';
import * as cliProgress from 'cli-progress';
import { DownloadOptions, DownloadProgress } from './item/download-options';
import { Book } from './item/Book';
import { ItemGroup } from './item/ItemGroup';
import { Item } from './item/Item';
import { TraunerShelf } from './shelf/TraunerShelf';
import { KlettShelf } from './shelf/KlettShelf';
import retry from 'async-retry';
import { ItemRef } from './item/ItemRef';
import { join } from 'path';
import { promises as fs } from 'fs';
import sanitize from 'sanitize-filename';

const cmd = command({
  name: 'd4sd',
  description:
    'Digi4school Downloader\n' +
    '> Downloads books from https://digi4school.at/ and https://www.scook.at/\n' +
    '> GitHub: https://github.com/garzj/d4sd',
  version: process.env.npm_package_version,
  args: {
    books: restPositionals({
      displayName: 'books',
      type: string,
      description:
        'The titles or urls of books or archives you want to download. Supports glob patterns.',
    }),
    user: option({
      long: 'user',
      short: 'u',
      type: string,
      description: 'Your login email/username.',
    }),
    password: option({
      long: 'password',
      short: 'p',
      type: optional(string),
      description: 'Your login password.',
    }),
    shelf: option({
      long: 'shelf',
      short: 's',
      defaultValue: () => 'digi',
      description: 'Log onto another shelf instead.',
      type: string,
    }),
    concurrency: option({
      long: 'concurrency',
      short: 'c',
      type: number,
      defaultValue: () => 10,
      description: 'Specifies the maximum amount of pages downloaded at once.',
    }),
    maxRetries: option({
      long: 'max-retries',
      short: 'r',
      type: number,
      defaultValue: () => 10,
      description: 'Change the maximum retries value.',
    }),
    outDir: option({
      long: 'out-dir',
      short: 'o',
      type: string,
      defaultValue: () => '.',
      description: 'The directory, the item should be saved into.',
    }),
    format: option({
      long: 'format',
      type: optional(string),
      description: 'A puppeteer page format like "a4".',
    }),
    timeout: option({
      long: 'timeout',
      short: 't',
      type: optional(number),
      description: 'Terminates the download, when exceeded.',
      defaultValue: () => 300000,
    }),
    all: flag({
      long: 'all',
      description: 'Download all books from the shelf.',
      type: boolean,
    }),
    allMissing: flag({
      long: 'all-missing',
      description:
        'Download all books from the shelf that are not yet in the output directory.',
      type: boolean,
    }),
    list: flag({
      long: 'list',
      description: 'List all books on the shelf without downloading.',
      type: boolean,
    }),
    listMissing: flag({
      long: 'list-missing',
      description: 'List all books on the shelf that are not yet in the output directory.',
      type: boolean,
    }),
    pageCount: option({
      long: 'page-count',
      type: optional(number),
      description: 'Manually specify the page count (useful when auto-detection fails).',
    }),
  },
  handler: async (args) => {
    if (args.format && !hasOwnProperty(paperFormats, args.format)) {
      console.error(
        `Invalid page format specified. Possible options are: ${Object.keys(
          paperFormats
        ).join(', ')}`
      );
      return;
    }

    if (args.books.length < 1 && !args.all && !args.allMissing && !args.list && !args.listMissing) {
      console.error('Please specify at least one book title or url.');
      return;
    }

    let password: string;
    if (args.password) {
      password = args.password;
    } else {
      password = (
        await inquirer.prompt([
          { name: 'password', type: 'password', message: 'Password:' },
        ])
      ).password;
      console.log('');
    }

    const shelfs = [DigiShelf, ScookShelf, TraunerShelf, KlettShelf];
    const shelfClass = shelfs.find((shelf) => shelf.id === args.shelf);
    if (shelfClass === undefined) {
      console.error(
        `Invalid shelf id specified. Possible options are: ${shelfs
          .map((shelf) => shelf.id)
          .join(', ')}`
      );
      return;
    }

    if (shelfClass === KlettShelf) {
      console.warn('⚠️  Warning: Klett shelf support is a work in progress and not working yet.');
    }
    try {
      const shelf: Shelf = await shelfClass.load({
        user: args.user,
        password,
        timeout: args.timeout,
      });

      try {
        let bookUrls: string[] = [];
        let bookTitles: string[] = [];
        for (const book of args.books) {
          if (shelf.origins.some((o) => book.startsWith(o))) {
            bookUrls.push(book);
          } else {
            bookTitles.push(book);
          }
        }

        const downloadAll = args.all || args.allMissing;
        const listMode = args.list || args.listMissing;
        let itemRefs =
          downloadAll || listMode || bookTitles.length > 0 ? await shelf.getItems() : [];

        if (listMode) {
          let refs = itemRefs;
          if (args.listMissing) {
            const filtered: ItemRef[] = [];
            for (const ref of refs) {
              const pdfPath = join(args.outDir, sanitize(ref.title) + '.pdf');
              const folderPath = join(args.outDir, sanitize(ref.title));
              const exists = await Promise.all([
                fs.access(pdfPath).then(() => true).catch(() => false),
                fs.access(folderPath).then(() => true).catch(() => false),
              ]).then(([pdf, folder]) => pdf || folder);
              if (!exists) filtered.push(ref);
            }
            refs = filtered;
          }
          for (const ref of refs) {
            console.log(ref.title);
          }
          return;
        }

        if (!downloadAll) {
          // filter specified books
          itemRefs = itemRefs.filter(
            (ref) =>
              bookTitles.some((title) =>
                minimatch(ref.title, title, {
                  nocase: true,
                  dot: true,
                  noglobstar: true,
                  nocomment: true,
                })
              ) ||
              bookUrls.some(
                (url) => url.replace(/\/$/, '') === ref.url.replace(/\/$/, '')
              )
          );

          // add the rest of the book urls with the url as title
          for (const bookUrl of bookUrls) {
            if (
              !itemRefs.some(
                (ref) => bookUrl.replace(/\/$/, '') === ref.url.replace(/\/$/, '')
              )
            ) {
              itemRefs.push(new ItemRef(shelf, bookUrl, bookUrl));
            }
          }
        }

        if (args.allMissing) {
          // filter out books that already have a merged PDF in outDir
          const filtered: ItemRef[] = [];
          for (const ref of itemRefs) {
            const pdfPath = join(args.outDir, sanitize(ref.title) + '.pdf');
            const folderPath = join(args.outDir, sanitize(ref.title));
            const exists = await Promise.all([
              fs.access(pdfPath).then(() => true).catch(() => false),
              fs.access(folderPath).then(() => true).catch(() => false),
            ]).then(([pdf, folder]) => pdf || folder);
            if (!exists) filtered.push(ref);
          }
          if (itemRefs.length > filtered.length) {
            console.log(
              `Skipping ${itemRefs.length - filtered.length} already-downloaded book(s).`
            );
          }
          itemRefs = filtered;
        }

        if (itemRefs.length === 0) {
          console.error(`No items matching your rules could be found.`);
        } else {
          for (const itemRef of itemRefs) {
            console.log(`Resolving "${itemRef.title}"...`);
            const item = await retry(() => itemRef.resolve(), {
              retries: args.maxRetries,
            });
            if (!item) {
              console.error(
                `Failed to resolve item type of "${itemRef.title}". Retried ${args.maxRetries} times.`
              );
              continue;
            }

            console.log(`Downloading "${itemRef.title}"...`);

            const multiBar = new cliProgress.MultiBar(
              {
                format:
                  ' {bar} | {value}/{total} | {percentage}% | ETA: {eta}s | {title}',
              },
              cliProgress.Presets.shades_classic
            );
            const bars = new Map<Item, cliProgress.Bar>();
            const barsUpdater = setInterval(
              () => bars.forEach((bar) => bar.updateETA()),
              1000
            );

            const options: DownloadOptions = {
              ...args,
              format: args.format as PaperFormat | undefined,
              onStart(progress) {
                let bar: cliProgress.SingleBar | null = null;
                if (progress.item instanceof Book) {
                  bar = multiBar.create(
                    (progress as DownloadProgress<Book>).pageCount,
                    0,
                    {
                      title: `${progress.item.constructor.name}: ${progress.item.title}`,
                    }
                  );
                } else if (progress.item instanceof ItemGroup) {
                  bar = multiBar.create(
                    (progress as DownloadProgress<ItemGroup>).items.length,
                    0,
                    { title: `Group: ${progress.item.title}` }
                  );
                }
                bar && bars.set(progress.item, bar);
              },
              onProgress(progress) {
                const bar = bars.get(progress.item)!;
                if (progress.item instanceof Book) {
                  bar.update(
                    (progress as DownloadProgress<Book>).downloadedPages
                  );
                } else if (progress.item instanceof ItemGroup) {
                  bar.update(
                    (progress as DownloadProgress<ItemGroup>).downloadedItems
                      .length
                  );
                }
              },
            };

            let err: unknown = null;
            try {
              await retry(() => item.download(args.outDir, options), {
                retries: args.maxRetries,
                onRetry(e, r) {
                  console.error(e);
                  console.error(
                    `Download failed. Retrying. (${r}/${args.maxRetries})`
                  );
                },
              });
            } catch (e) {
              err = e;
            }

            clearInterval(barsUpdater);
            multiBar.stop();

            if (err) {
              console.error(err);
              console.error(
                `Failed to download "${itemRef.title}! Retried ${args.maxRetries} times."`
              );
              continue;
            }

            console.log(`Successfully downloaded "${itemRef.title}"!`);
          }
        }
      } finally {
        await shelf.destroy();
      }
    } catch (e) {
      console.log(`Error: ${e instanceof Error ? e.message : e}`);
    }
  },
});

run(cmd, process.argv.slice(2));
