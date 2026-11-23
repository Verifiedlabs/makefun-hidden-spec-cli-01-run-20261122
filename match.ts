export type Tier = 0 | 1 | 2;

export interface MatchResult {
  tier: Tier;
  positions: number[];
}

export interface MatchOptions {
  minStart?: number;
  requireEof?: boolean;
}

export interface ChunkBodyLine {
  kind: 'context' | 'old' | 'new';
  text: string;
}

export function stripTrailingSpaceTab(line: string): string {
  let end = line.length;
  while (end > 0) {
    const ch = line.charCodeAt(end - 1);
    if (ch === 0x20 || ch === 0x09) end -= 1;
    else break;
  }
  return end === line.length ? line : line.slice(0, end);
}

export function stripBothSpaceTab(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end) {
    const ch = line.charCodeAt(start);
    if (ch === 0x20 || ch === 0x09) start += 1;
    else break;
  }
  while (end > start) {
    const ch = line.charCodeAt(end - 1);
    if (ch === 0x20 || ch === 0x09) end -= 1;
    else break;
  }
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

export function leadingSpaceTab(line: string): string {
  let i = 0;
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 0x20 || ch === 0x09) i += 1;
    else break;
  }
  return line.slice(0, i);
}

function normalizeAtTier(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return stripTrailingSpaceTab(line);
  return stripBothSpaceTab(line);
}

export function findLineOccurrences(
  fileLines: readonly string[],
  oldLines: readonly string[],
  strict: boolean,
  opts: MatchOptions = {},
): MatchResult | null {
  const m = oldLines.length;
  if (m === 0) return null;
  const minStart = opts.minStart ?? 0;
  const maxStart = fileLines.length - m;
  if (minStart > maxStart) return null;

  const tiers: readonly Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const needle = oldLines.map((l) => normalizeAtTier(l, tier));
    const positions: number[] = [];

    if (opts.requireEof) {
      const start = maxStart;
      if (start >= minStart) {
        let ok = true;
        for (let j = 0; j < m; j += 1) {
          if (normalizeAtTier(fileLines[start + j]!, tier) !== needle[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(start);
      }
    } else {
      for (let i = minStart; i <= maxStart; i += 1) {
        let ok = true;
        for (let j = 0; j < m; j += 1) {
          if (normalizeAtTier(fileLines[i + j]!, tier) !== needle[j]) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }

    if (positions.length > 0) {
      return { tier, positions };
    }
  }

  return null;
}

export function reindentLine(line: string, fileIndent: string, patchIndent: string): string {
  if (line.trim() === '') return line;
  if (line.startsWith(patchIndent)) {
    return fileIndent + line.slice(patchIndent.length);
  }
  return line;
}

export function buildChunkReplacement(
  fileLines: readonly string[],
  matchPos: number,
  tier: Tier,
  oldLines: readonly string[],
  bodyLines: readonly ChunkBodyLine[],
): string[] {
  const fileIndent = leadingSpaceTab(fileLines[matchPos]!);
  const patchIndent = leadingSpaceTab(oldLines[0]!);
  const out: string[] = [];
  let oldIdx = 0;

  for (const item of bodyLines) {
    if (item.kind === 'context') {
      out.push(fileLines[matchPos + oldIdx]!);
      oldIdx += 1;
    } else if (item.kind === 'old') {
      oldIdx += 1;
    } else {
      if (tier === 2) {
        out.push(reindentLine(item.text, fileIndent, patchIndent));
      } else {
        out.push(item.text);
      }
    }
  }

  return out;
}

export function buildBlockReplacement(
  fileLines: readonly string[],
  matchPos: number,
  tier: Tier,
  oldLines: readonly string[],
  newLines: readonly string[],
): string[] {
  if (tier !== 2) {
    return [...newLines];
  }
  const fileIndent = leadingSpaceTab(fileLines[matchPos]!);
  const patchIndent = leadingSpaceTab(oldLines[0]!);
  return newLines.map((line) => reindentLine(line, fileIndent, patchIndent));
}
