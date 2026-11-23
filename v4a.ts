import { Exit2, Fail, isBlank, isSafePath, joinFile, splitFile } from './core.ts';
import type { Edit, Tree } from './core.ts';
import { buildChunkReplacement, findLineOccurrences } from './match.ts';
import type { ChunkBodyLine } from './match.ts';

interface NumberedLine {
  lineNo: number;
  text: string;
}

interface V4AChunk {
  anchor: string;
  body: ChunkBodyLine[];
  eof: boolean;
}

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOVE_PREFIX = '*** Move to: ';

function isSectionStart(line: string): boolean {
  return line.startsWith(ADD_PREFIX) || line.startsWith(DEL_PREFIX) || line.startsWith(UPD_PREFIX);
}

export function parseV4AEdits(lines: readonly string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) {
    throw new Exit2('error: parse 1');
  }
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }

  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last <= first || lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }

  const edits: Edit[] = [];
  let i = first + 1;

  while (i < last) {
    if (isBlank(lines[i]!)) {
      i += 1;
      continue;
    }

    const headerLineNo = i + 1;
    const header = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;

    if (header.startsWith(ADD_PREFIX)) {
      kind = 'add';
      path = header.slice(ADD_PREFIX.length).trim();
    } else if (header.startsWith(DEL_PREFIX)) {
      kind = 'delete';
      path = header.slice(DEL_PREFIX.length).trim();
    } else if (header.startsWith(UPD_PREFIX)) {
      kind = 'update';
      path = header.slice(UPD_PREFIX.length).trim();
    } else {
      throw new Exit2(`error: parse ${headerLineNo}`);
    }

    i += 1;
    const rawBody: NumberedLine[] = [];
    while (i < last && !isSectionStart(lines[i]!)) {
      rawBody.push({ lineNo: i + 1, text: lines[i]! });
      i += 1;
    }

    while (rawBody.length > 0 && isBlank(rawBody[rawBody.length - 1]!.text)) {
      rawBody.pop();
    }

    if (kind === 'add') {
      const addLines: string[] = [];
      for (const item of rawBody) {
        if (item.text.startsWith('+')) {
          addLines.push(item.text.slice(1));
        } else if (item.text === '') {
          addLines.push('');
        } else {
          throw new Exit2(`error: parse ${item.lineNo}`);
        }
      }
      edits.push((tree: Tree) => {
        if (!isSafePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinFile({ lines: addLines, eol: '\n', trailingEol: true }));
      });
      continue;
    }

    if (kind === 'delete') {
      if (rawBody.length > 0) {
        throw new Exit2(`error: parse ${rawBody[0]!.lineNo}`);
      }
      edits.push((tree: Tree) => {
        if (!isSafePath(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }

    // Update File
    let bodyIdx = 0;
    let moveTo: string | null = null;
    if (bodyIdx < rawBody.length && rawBody[bodyIdx]!.text.startsWith(MOVE_PREFIX)) {
      moveTo = rawBody[bodyIdx]!.text.slice(MOVE_PREFIX.length).trim();
      bodyIdx += 1;
    }

    const chunks: V4AChunk[] = [];
    let currentChunk: V4AChunk | null = null;

    while (bodyIdx < rawBody.length) {
      const { lineNo, text } = rawBody[bodyIdx]!;
      bodyIdx += 1;

      if (text.startsWith('@@')) {
        currentChunk = {
          anchor: text.slice(2).trim(),
          body: [],
          eof: false,
        };
        chunks.push(currentChunk);
        continue;
      }

      if (text.trimEnd() === '*** End of File') {
        if (currentChunk === null) {
          throw new Exit2(`error: parse ${lineNo}`);
        }
        currentChunk.eof = true;
        currentChunk = null;
        continue;
      }

      if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
        if (currentChunk === null) {
          if (chunks.length === 0) {
            currentChunk = { anchor: '', body: [], eof: false };
            chunks.push(currentChunk);
          } else {
            throw new Exit2(`error: parse ${lineNo}`);
          }
        }
        if (text === '') {
          currentChunk.body.push({ kind: 'context', text: '' });
        } else if (text.startsWith(' ')) {
          currentChunk.body.push({ kind: 'context', text: text.slice(1) });
        } else if (text.startsWith('-')) {
          currentChunk.body.push({ kind: 'old', text: text.slice(1) });
        } else {
          currentChunk.body.push({ kind: 'new', text: text.slice(1) });
        }
        continue;
      }

      throw new Exit2(`error: parse ${lineNo}`);
    }

    if (chunks.length === 0 && moveTo === null) {
      throw new Exit2(`error: parse ${headerLineNo}`);
    }

    edits.push((tree: Tree) => {
      if (!isSafePath(path)) throw new Fail('unsafe', path);
      if (moveTo !== null && !isSafePath(moveTo)) throw new Fail('unsafe', moveTo);

      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) {
        throw new Fail('exists', moveTo);
      }

      const file = splitFile(before);
      let cursor = 0;

      for (const chunk of chunks) {
        if (chunk.anchor !== '') {
          const anchorMatch = findLineOccurrences(file.lines, [chunk.anchor], strict, {
            minStart: cursor,
          });
          if (anchorMatch === null) {
            throw new Fail('no-match', path);
          }
          cursor = anchorMatch.positions[0]! + 1;
        }

        const oldLines: string[] = [];
        const newLines: string[] = [];
        for (const item of chunk.body) {
          if (item.kind === 'context') {
            oldLines.push(item.text);
            newLines.push(item.text);
          } else if (item.kind === 'old') {
            oldLines.push(item.text);
          } else {
            newLines.push(item.text);
          }
        }

        if (oldLines.length === 0) {
          const insertAt = chunk.eof ? file.lines.length : cursor;
          file.lines.splice(insertAt, 0, ...newLines);
          cursor = insertAt + newLines.length;
        } else {
          const found = findLineOccurrences(file.lines, oldLines, strict, {
            minStart: cursor,
            requireEof: chunk.eof,
          });
          if (found === null) {
            throw new Fail('no-match', path);
          }
          const pos = found.positions[0]!;
          const replacement = buildChunkReplacement(file.lines, pos, found.tier, oldLines, chunk.body);
          file.lines.splice(pos, oldLines.length, ...replacement);
          cursor = pos + replacement.length;
        }
      }

      const outText = joinFile(file);
      if (moveTo !== null) {
        tree.now.set(path, null);
        tree.now.set(moveTo, outText);
        tree.recordMove(path, moveTo);
      } else {
        tree.now.set(path, outText);
      }
    });
  }

  return edits;
}
