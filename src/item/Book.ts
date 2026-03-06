import { join } from 'path';
import { tmpdir } from 'os';
import { Item } from './Item';
import { PDFDocument } from 'pdf-lib';
import { promises } from 'fs';
const { rm, mkdir, readFile, writeFile, access } = promises;

export abstract class Book extends Item {
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
    const outFile = `${subDir}.pdf`;
    const mergedPdf = await PDFDocument.create();

    for (let pageNo = 1; pageNo <= pageCount; pageNo++) {
      const inFile = this.getTempPdfPath(pageNo);
      try {
        await access(inFile);
      } catch {
        console.warn(`Skipping missing page ${pageNo} of "${this.title}"`);
        continue;
      }
      try {
        const pdfBytes = await readFile(inFile);
        const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((page) => mergedPdf.addPage(page));
      } catch (e) {
        console.warn(`Skipping corrupt page ${pageNo} of "${this.title}": ${e}`);
      }
    }

    const mergedBytes = await mergedPdf.save();
    await writeFile(outFile, mergedBytes);

    if (this._tempDir) {
      await rm(this._tempDir, { recursive: true }).catch(() => {});
    }

    await rm(subDir, { recursive: true, force: true } as any).catch(() => {});
  }
}
