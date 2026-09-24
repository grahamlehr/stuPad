import JSZip from 'jszip';
import { parseXml, children, attr } from './xml';

export interface Rel {
  id: string;
  type: string;
  target: string;
}

/** Resolve a rels-file target (which is relative to the *part's* directory) to a zip path. */
export function resolvePath(basePartPath: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const baseDir = basePartPath.split('/').slice(0, -1);
  const parts = target.split('/');
  const stack = [...baseDir];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/');
}

/** rels file path for a given part, e.g. ppt/slides/slide1.xml -> ppt/slides/_rels/slide1.xml.rels */
export function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf('/');
  const dir = idx >= 0 ? partPath.slice(0, idx) : '';
  const name = idx >= 0 ? partPath.slice(idx + 1) : partPath;
  return `${dir ? dir + '/' : ''}_rels/${name}.rels`;
}

export class Pkg {
  constructor(public zip: JSZip) {}

  static async load(input: Blob | ArrayBuffer): Promise<Pkg> {
    const buf = input instanceof Blob ? await input.arrayBuffer() : input;
    const zip = await JSZip.loadAsync(buf);
    return new Pkg(zip);
  }

  has(path: string): boolean {
    return this.zip.file(path) != null;
  }

  async text(path: string): Promise<string | null> {
    const f = this.zip.file(path);
    if (!f) return null;
    return f.async('string');
  }

  async xml(path: string): Promise<Document | null> {
    const t = await this.text(path);
    if (t == null) return null;
    return parseXml(t);
  }

  async blob(path: string, mime: string): Promise<Blob | null> {
    const f = this.zip.file(path);
    if (!f) return null;
    const data = await f.async('uint8array');
    const copy = data.slice(); // ensures a plain ArrayBuffer-backed view, not SharedArrayBuffer
    return new Blob([copy], { type: mime });
  }

  /** Parse the .rels file for a given part, if present. */
  async relsFor(partPath: string): Promise<Rel[]> {
    const doc = await this.xml(relsPathFor(partPath));
    if (!doc) return [];
    return children(doc, 'Relationship').map((el) => ({
      id: attr(el, 'Id') ?? '',
      type: attr(el, 'Type') ?? '',
      target: resolvePath(partPath, attr(el, 'Target') ?? ''),
    }));
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

export function mimeForPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
