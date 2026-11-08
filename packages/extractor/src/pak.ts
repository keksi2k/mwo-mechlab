import yauzl from 'yauzl';

/** Reads single files from a pak (ZIP) without loading the archive into memory. Read-only. */
export class Pak {
  private zip: yauzl.ZipFile;
  private entries: Map<string, yauzl.Entry>;
  private constructor(zip: yauzl.ZipFile, entries: Map<string, yauzl.Entry>) {
    this.zip = zip;
    this.entries = entries;
  }

  static open(path: string): Promise<Pak> {
    return new Promise((resolve, reject) => {
      yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error(`Cannot open ${path}`));
        const entries = new Map<string, yauzl.Entry>();
        zip.on('entry', (e: yauzl.Entry) => {
          entries.set(e.fileName.toLowerCase(), e);
          zip.readEntry();
        });
        zip.on('end', () => resolve(new Pak(zip, entries)));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }

  /** File names in their original spelling */
  names(): string[] {
    return [...this.entries.values()].map((e) => e.fileName);
  }

  read(name: string): Promise<Buffer> {
    const entry = this.entries.get(name.toLowerCase());
    if (!entry) throw new Error(`Not in pak: ${name}`);
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error(`Cannot read ${name}`));
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
      });
    });
  }

  async readText(name: string): Promise<string> {
    return (await this.read(name)).toString('utf8').replace(/^﻿/, '');
  }

  close() {
    this.zip.close();
  }
}
