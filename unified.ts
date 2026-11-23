import { Exit2, Fail, isSafePath, joinFile, splitFile } from './core.ts';
import type { Edit, Tree } from './core.ts';
import { buildChunkReplacement, findLineOccurrences } from './match.ts';
import type { ChunkBodyLine } from './match.ts';

interface RawBodyEntry {
  kind: 'context' | 'old' | 'new' | 'noeol';
  text: string;
  isBareEmpty: boolean;
}

interface UnifiedHunk {
  oldStart: number;
  entries: RawBodyEntry[];
}

interface UnifiedSection {
  gitOld: string | null;
  gitNew: string | null;
  mpOld: string | null;
  mpNew: string | null;
  hasMinusPlus: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UnifiedHunk[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIFF_GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;

function parseDiffGitLine(line: string, lineNo: number): [string, string] {
  const m = DIFF_GIT_RE.exec(line);
  if (!m) {
    throw new Exit2(`error: parse ${lineNo}`);
  }
  const oldP = m[1]!;
  const newP = m[2]!;
  if (oldP.trim() === '' || newP.trim() === '' || oldP !== oldP.trim() || newP !== newP.trim()) {
    throw new Exit2(`error: parse ${lineNo}`);
  }
  return [oldP, newP];
}

function parseHeaderPath(rawAfterPrefix: string): string | null {
  const tabIdx = rawAfterPrefix.indexOf('\t');
  const beforeTab = tabIdx >= 0 ? rawAfterPrefix.slice(0, tabIdx) : rawAfterPrefix;
  const trimmed = beforeTab.trim();
  if (trimmed === '/dev/null') return null;
  if (trimmed.startsWith('a/') || trimmed.startsWith('b/')) {
    return trimmed.slice(2);
  }
  return trimmed;
}

function isDiffGitPrefix(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

function isMinusPlusPair(lines: readonly string[], idx: number): boolean {
  return lines[idx]!.startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1]!.startsWith('+++ ');
}

function parseUnifiedSections(lines: readonly string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let current: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (isDiffGitPrefix(line)) {
      const [gitOld, gitNew] = parseDiffGitLine(line, i + 1);
      current = {
        gitOld,
        gitNew,
        mpOld: null,
        mpNew: null,
        hasMinusPlus: false,
        renameFrom: null,
        renameTo: null,
        newFileMode: false,
        deletedFileMode: false,
        hunks: [],
      };
      sections.push(current);
      inHeader = true;
      i += 1;
      continue;
    }

    if (inHeader && current !== null && !current.hasMinusPlus && line.startsWith('--- ')) {
      if (i + 1 >= lines.length || !lines[i + 1]!.startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      current.mpOld = parseHeaderPath(line.slice(4));
      current.mpNew = parseHeaderPath(lines[i + 1]!.slice(4));
      current.hasMinusPlus = true;
      i += 2;
      continue;
    }

    if (isMinusPlusPair(lines, i)) {
      current = {
        gitOld: null,
        gitNew: null,
        mpOld: parseHeaderPath(line.slice(4)),
        mpNew: parseHeaderPath(lines[i + 1]!.slice(4)),
        hasMinusPlus: true,
        renameFrom: null,
        renameTo: null,
        newFileMode: false,
        deletedFileMode: false,
        hunks: [],
      };
      sections.push(current);
      inHeader = true;
      i += 2;
      continue;
    }

    if (inHeader && current !== null) {
      if (line.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        current.renameFrom = line.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        current.renameTo = line.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        current.newFileMode = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        current.deletedFileMode = true;
        i += 1;
        continue;
      }
    }

    if (line.startsWith('@@')) {
      if (current === null) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const hm = HUNK_HEADER_RE.exec(line);
      if (!hm) {
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const oldStart = Number(hm[1]!);
      inHeader = false;
      i += 1;

      const entries: RawBodyEntry[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isMinusPlusPair(lines, i)) {
          break;
        }
        if (bl === '') {
          entries.push({ kind: 'context', text: '', isBareEmpty: true });
          i += 1;
        } else if (bl.startsWith(' ')) {
          entries.push({ kind: 'context', text: bl.slice(1), isBareEmpty: false });
          i += 1;
        } else if (bl.startsWith('-')) {
          entries.push({ kind: 'old', text: bl.slice(1), isBareEmpty: false });
          i += 1;
        } else if (bl.startsWith('+')) {
          entries.push({ kind: 'new', text: bl.slice(1), isBareEmpty: false });
          i += 1;
        } else if (bl.startsWith('\\')) {
          entries.push({ kind: 'noeol', text: bl.slice(1), isBareEmpty: false });
          i += 1;
        } else {
          break;
        }
      }

      while (entries.length > 0 && entries[entries.length - 1]!.isBareEmpty) {
        entries.pop();
      }
      current.hunks.push({ oldStart, entries });
      continue;
    }

    i += 1;
  }

  return sections;
}

function lastContextOrNewHasNoEol(entries: readonly RawBodyEntry[]): boolean {
  let lastIdx = -1;
  for (let i = 0; i < entries.length; i += 1) {
    const k = entries[i]!.kind;
    if (k === 'context' || k === 'new') {
      lastIdx = i;
    }
  }
  return lastIdx >= 0 && lastIdx + 1 < entries.length && entries[lastIdx + 1]!.kind === 'noeol';
}

function applyUnifiedHunks(
  text: string,
  hunks: readonly UnifiedHunk[],
  strict: boolean,
  errPath: string,
): string {
  const file = splitFile(text);
  let delta = 0;

  for (const hunk of hunks) {
    const body: ChunkBodyLine[] = [];
    const oldLines: string[] = [];
    const newLines: string[] = [];

    for (const entry of hunk.entries) {
      if (entry.kind === 'noeol') continue;
      body.push({ kind: entry.kind, text: entry.text });
      if (entry.kind === 'context') {
        oldLines.push(entry.text);
        newLines.push(entry.text);
      } else if (entry.kind === 'old') {
        oldLines.push(entry.text);
      } else {
        newLines.push(entry.text);
      }
    }

    const noEol = lastContextOrNewHasNoEol(hunk.entries);

    if (oldLines.length === 0) {
      const insertAt = Math.max(0, Math.min(file.lines.length, hunk.oldStart + delta));
      const atEnd = insertAt === file.lines.length;
      file.lines.splice(insertAt, 0, ...newLines);
      if (atEnd) {
        file.trailingEol = !noEol;
      }
      delta += newLines.length;
    } else {
      const found = findLineOccurrences(file.lines, oldLines, strict);
      if (found === null) {
        throw new Fail('no-match', errPath);
      }
      const target = hunk.oldStart - 1 + delta;
      let bestPos = found.positions[0]!;
      let bestDist = Math.abs(bestPos - target);
      for (let k = 1; k < found.positions.length; k += 1) {
        const pos = found.positions[k]!;
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          bestDist = dist;
          bestPos = pos;
        }
      }
      const runsToEnd = bestPos + oldLines.length === file.lines.length;
      const replacement = buildChunkReplacement(file.lines, bestPos, found.tier, oldLines, body);
      file.lines.splice(bestPos, oldLines.length, ...replacement);
      if (runsToEnd) {
        file.trailingEol = !noEol;
      }
      delta += replacement.length - oldLines.length;
    }
  }

  return joinFile(file);
}

function buildSectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  const isCreation = sec.newFileMode || (sec.hasMinusPlus && sec.mpOld === null);
  const isDeletion = sec.deletedFileMode || (sec.hasMinusPlus && sec.mpNew === null);

  const oldPath = sec.hasMinusPlus ? sec.mpOld : (sec.renameFrom ?? sec.gitOld);
  const newPath = sec.hasMinusPlus ? sec.mpNew : (sec.renameTo ?? sec.gitNew);

  if (isCreation) {
    const target = newPath ?? sec.renameTo ?? sec.gitNew ?? '';
    return (tree: Tree) => {
      if (!isSafePath(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);

      const createdLines: string[] = [];
      let lastPlusNoEol = false;
      for (const hunk of sec.hunks) {
        for (let j = 0; j < hunk.entries.length; j += 1) {
          const e = hunk.entries[j]!;
          if (e.kind === 'new') {
            createdLines.push(e.text);
            lastPlusNoEol = j + 1 < hunk.entries.length && hunk.entries[j + 1]!.kind === 'noeol';
          }
        }
      }
      const content = joinFile({
        lines: createdLines,
        eol: '\n',
        trailingEol: !lastPlusNoEol,
      });
      tree.now.set(target, content);
    };
  }

  if (isDeletion) {
    const target = oldPath ?? sec.renameFrom ?? sec.gitOld ?? '';
    return (tree: Tree) => {
      if (!isSafePath(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }

  const from = oldPath ?? '';
  const to = newPath ?? '';

  if (from !== to) {
    return (tree: Tree) => {
      if (!isSafePath(from)) throw new Fail('unsafe', from);
      if (!isSafePath(to)) throw new Fail('unsafe', to);
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);

      const after = applyUnifiedHunks(before, sec.hunks, strict, from);
      tree.now.set(from, null);
      tree.now.set(to, after);
      tree.recordMove(from, to);
    };
  }

  return (tree: Tree) => {
    if (!isSafePath(from)) throw new Fail('unsafe', from);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);

    const after = applyUnifiedHunks(before, sec.hunks, strict, from);
    tree.now.set(from, after);
  };
}

export function parseUnifiedEdits(lines: readonly string[], strict: boolean): Edit[] {
  const sections = parseUnifiedSections(lines);
  return sections.map((sec) => buildSectionEdit(sec, strict));
}
