// mend: deterministic multi-format patch CLI implementing SPEC.md v1 (Node 22, stdlib only).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { Exit2, Fail, Tree, byteCompare, isBlank, patchLines } from './core.ts';
import type { Edit } from './core.ts';
import { parseJsonEdits } from './json-edits.ts';
import { parseSearchReplaceEdits } from './search-replace.ts';
import { parseUnifiedEdits } from './unified.ts';
import { parseV4AEdits } from './v4a.ts';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

function detectFormat(lines: readonly string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const lead = lines[first]!.trimStart()[0];
  if (lead === '[' || lead === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

interface ChangeRow {
  sortKey: string;
  line: string;
}

function formatSuccessOutput(tree: Tree): ChangeRow[] {
  const renamedOld = new Set<string>();
  const renamedNew = new Set<string>();
  const rows: ChangeRow[] = [];

  for (const [oldPath, newPath] of tree.moves) {
    if (renamedOld.has(oldPath) || renamedNew.has(newPath)) continue;
    const oldWas = tree.original(oldPath);
    const oldNow = tree.get(oldPath);
    const newWas = tree.original(newPath);
    const newNow = tree.get(newPath);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      renamedOld.add(oldPath);
      renamedNew.add(newPath);
      rows.push({ sortKey: newPath, line: `R ${oldPath} -> ${newPath}` });
    }
  }

  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (was !== null && now === null && renamedOld.has(p)) continue;
    if (was === null && now !== null && renamedNew.has(p)) continue;
    const code = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ sortKey: p, line: `${code} ${p}` });
  }

  rows.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  return rows;
}

function commitTreeToDisk(tree: Tree): void {
  const deletions: string[] = [];
  const writes: Array<[string, string]> = [];

  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) deletions.push(p);
    else writes.push([p, now]);
  }

  for (const p of deletions) {
    rmSync(p, { force: true });
  }

  for (const [p, content] of writes) {
    try {
      if (statSync(p).isDirectory()) {
        rmSync(p, { recursive: true, force: true });
      }
    } catch {
      // path does not exist yet
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
}

export function run(args: readonly string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;

  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (
        arg.startsWith('--format=') &&
        format === null &&
        (FORMATS as readonly string[]).includes(arg.slice(9))
      ) {
        format = arg.slice(9);
      } else if (arg === '--check' && !check) {
        check = true;
      } else if (arg === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 1) {
    return { code: 2, out: ['error: usage'] };
  }

  const patchPath = positional.length === 0 || positional[0] === '-' ? null : positional[0]!;
  let text = '';
  try {
    text = readFileSync(patchPath ?? 0, 'utf8');
  } catch {
    if (patchPath !== null) {
      return { code: 2, out: ['error: no-patch'] };
    }
  }

  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) {
    return { code: 2, out: ['error: format'] };
  }

  let edits: Edit[];
  try {
    if (kind === 'unified') {
      edits = parseUnifiedEdits(lines, strict);
    } else if (kind === 'search-replace') {
      edits = parseSearchReplaceEdits(lines, strict);
    } else if (kind === 'v4a') {
      edits = parseV4AEdits(lines, strict);
    } else {
      edits = parseJsonEdits(text, lines);
    }
    if (edits.length === 0) {
      throw new Exit2('error: parse 1');
    }
  } catch (err) {
    if (err instanceof Exit2) {
      return { code: 2, out: [err.line] };
    }
    throw err;
  }

  const tree = new Tree();
  const fails: Fail[] = [];

  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      tree.now.clear();
      for (const [k, v] of beforeNow) {
        tree.now.set(k, v);
      }
      tree.moves.length = beforeMoves;
      fails.push(err);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }

  const rows = formatSuccessOutput(tree);
  if (!check) {
    commitTreeToDisk(tree);
  }
  const n = rows.length;
  return {
    code: 0,
    out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`],
  };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
