import { Exit2, Fail, isBlank, isSafePath, joinFile, splitFile } from './core.ts';
import type { Edit, Tree } from './core.ts';
import { buildBlockReplacement, findLineOccurrences } from './match.ts';

interface SearchReplaceBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

export function parseSearchReplaceEdits(lines: readonly string[], strict: boolean): Edit[] {
  const blocks: SearchReplaceBlock[] = [];
  let lastReplaceIdx = -1;
  let prevPath: string | null = null;
  let i = 0;

  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }

    const searchIdx = i;
    let foundPath: string | null = null;
    for (let k = searchIdx - 1; k > lastReplaceIdx; k -= 1) {
      const candidate = lines[k]!;
      if (isBlank(candidate)) continue;
      const trimmed = candidate.trim();
      if (trimmed.startsWith('```')) continue;
      foundPath = trimmed;
      break;
    }

    if (foundPath === null) {
      if (prevPath !== null) {
        foundPath = prevPath;
      } else {
        throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
    }

    let sepIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '=======') {
        sepIdx = j;
        break;
      }
      if (m === '>>>>>>> REPLACE' || m === '<<<<<<< SEARCH') {
        throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
    }
    if (sepIdx < 0) {
      throw new Exit2(`error: parse ${searchIdx + 1}`);
    }

    let endIdx = -1;
    for (let j = sepIdx + 1; j < lines.length; j += 1) {
      const m = lines[j]!.trimEnd();
      if (m === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
      if (m === '<<<<<<< SEARCH') {
        throw new Exit2(`error: parse ${searchIdx + 1}`);
      }
    }
    if (endIdx < 0) {
      throw new Exit2(`error: parse ${searchIdx + 1}`);
    }

    prevPath = foundPath;
    blocks.push({
      path: foundPath,
      oldLines: lines.slice(searchIdx + 1, sepIdx),
      newLines: lines.slice(sepIdx + 1, endIdx),
    });

    lastReplaceIdx = endIdx;
    i = endIdx + 1;
  }

  return blocks.map((block): Edit => {
    return (tree: Tree) => {
      if (!isSafePath(block.path)) {
        throw new Fail('unsafe', block.path);
      }
      if (block.oldLines.length === 0) {
        if (tree.get(block.path) !== null) {
          throw new Fail('exists', block.path);
        }
        const content = joinFile({
          lines: block.newLines,
          eol: '\n',
          trailingEol: true,
        });
        tree.now.set(block.path, content);
        return;
      }

      const before = tree.get(block.path);
      if (before === null) {
        throw new Fail('missing', block.path);
      }
      const file = splitFile(before);
      const found = findLineOccurrences(file.lines, block.oldLines, strict);
      if (found === null) {
        throw new Fail('no-match', block.path);
      }
      if (found.positions.length > 1) {
        throw new Fail('ambiguous', block.path);
      }

      const pos = found.positions[0]!;
      const replacement = buildBlockReplacement(
        file.lines,
        pos,
        found.tier,
        block.oldLines,
        block.newLines,
      );
      file.lines.splice(pos, block.oldLines.length, ...replacement);
      tree.now.set(block.path, joinFile(file));
    };
  });
}
