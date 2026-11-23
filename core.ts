import { readFileSync, statSync } from 'node:fs';

export class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

export class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

export interface TextFile {
  lines: string[];
  eol: '\n' | '\r\n';
  trailingEol: boolean;
}

export function isBlank(s: string): boolean {
  return s.trim() === '';
}

export function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

export function splitFile(text: string): TextFile {
  const firstLf = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') {
    return { lines: [], eol, trailingEol: false };
  }
  const trailingEol = text.endsWith(eol);
  const lines = text.split(eol);
  if (trailingEol) lines.pop();
  return { lines, eol, trailingEol };
}

export function joinFile(file: TextFile): string {
  if (file.lines.length === 0) return '';
  return file.lines.join(file.eol) + (file.trailingEol ? file.eol : '');
}

export function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let content: string | null = null;
      try {
        if (statSync(p).isFile()) {
          content = readFileSync(p, 'utf8');
        }
      } catch {
        content = null;
      }
      this.orig.set(p, content);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  recordMove(oldPath: string, newPath: string): void {
    this.moves.push([oldPath, newPath]);
  }
}

export type Edit = (tree: Tree) => void;
