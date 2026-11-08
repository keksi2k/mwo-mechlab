import { XMLParser } from 'fast-xml-parser';

/** Uniform XML node. Attribute lookup ignores case because the game data is inconsistent. */
export class El {
  tag: string;
  attrs: Record<string, string>;
  children: El[];
  text: string;
  private lower: Map<string, string> | null = null;
  constructor(tag: string, attrs: Record<string, string>, children: El[], text: string) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
    this.text = text;
  }
  get(name: string): string | undefined {
    if (name in this.attrs) return this.attrs[name];
    this.lower ??= new Map(Object.entries(this.attrs).map(([k, v]) => [k.toLowerCase(), v]));
    return this.lower.get(name.toLowerCase());
  }
  num(name: string, fallback = 0): number {
    const v = this.get(name);
    if (v === undefined) return fallback;
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  }
  all(tag: string): El[] {
    return this.children.filter((c) => c.tag === tag);
  }
  one(tag: string): El | undefined {
    return this.children.find((c) => c.tag === tag);
  }
  *walk(tag: string): Generator<El> {
    for (const c of this.children) {
      if (c.tag === tag) yield c;
      yield* c.walk(tag);
    }
  }
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

type Raw = Record<string, unknown> & { ':@'?: Record<string, string> };
function convert(raw: Raw): El | null {
  const tag = Object.keys(raw).find((k) => k !== ':@');
  if (!tag || tag === '#text') return null;
  const kids = (raw[tag] as Raw[]) ?? [];
  const children: El[] = [];
  let text = '';
  for (const k of kids) {
    if ('#text' in k) text += String(k['#text']);
    else {
      const el = convert(k);
      if (el) children.push(el);
    }
  }
  return new El(tag, raw[':@'] ?? {}, children, text);
}

export function parseXml(xml: string): El {
  const roots = (parser.parse(xml) as Raw[]).map(convert).filter((e): e is El => e !== null);
  if (roots.length === 0) throw new Error('XML without a root element');
  return roots[0]!;
}
