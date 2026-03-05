import { join } from 'path';
import { tmpdir } from 'os';
import { Item } from './Item';
import muhammara from 'muhammara';
import { ScrapeError } from '../error/ScrapeError';
import { promises } from 'fs';
const { rm, mkdir, copyFile, unlink, access } = promises;

export abstract class Book extends Item {
  // All muhammara I/O goes through this ASCII temp dir to avoid muhammara's
  // inability to handle Unicode / long Windows paths (it uses C fopen internally).
  private _tempDir?: string;

  async mkTempDir() {
    const dir = join(
      tmpdir(),
      `d4sd-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await mkdir(dir, { recursive: true });
    this._tempDir = dir;
    return dir;
  }

  getTempPdfPath(pageNo: number) {
    return join(this._tempDir!, `${pageNo}.pdf`);
  }

  getPdfPath(subDir: string, pageNo: number) {
    return join(subDir, `${pageNo}.pdf`);
  }

  async mergePdfPages(subDir: string, pageCount: number) {
    // Write merged PDF to a temp path (ASCII, short) then copy to final dest
    const outFile = `${subDir}.pdf`;
    const tmpMerged = join(tmpdir(), `d4sd-merged-${Date.now()}.pdf`);

    const writeStream = new muhammara.PDFWStreamForFile(tmpMerged);
    const writer = muhammara.createWriter(writeStream);

    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      // Read individual pages from temp dir (ASCII path)
      const inFile = this.getTempPdfPath(pageNo);
      try {
        await access(inFile); // skip if not downloaded
      } catch {
        console.warn(`Skipping missing page ${pageNo} of "${this.title}"`);
        continue;
      }
      try {
        writer.appendPDFPagesFromPDF(inFile);
      } catch (e) {
        console.warn(`Skipping corrupt page ${pageNo} of "${this.title}": ${e}`);
      }
    }

    writer.end();
    await new Promise<void>((resolve) => writeStream.close(resolve));

    // Copy merged result to the final (possibly Unicode) destination path
    await copyFile(tmpMerged, outFile);
    await unlink(tmpMerged);

    // Clean up temp dir
    if (this._tempDir) {
      await rm(this._tempDir, { recursive: true }).catch(() => {});
    }

    // Remove the (now unused) OneDrive subDir
    await rm(subDir, { recursive: true, force: true } as any).catch(() => {});
  }
}
