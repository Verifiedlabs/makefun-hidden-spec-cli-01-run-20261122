import { Exit2, Fail, isBlank, isSafePath, joinFile, patchLines, splitFile } from './core.ts';
import type { Edit, Tree } from './core.ts';

function buildJsonEdit(value: unknown): Edit | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const path = obj.path;
  if (typeof path !== 'string') return null;

  const requireExisting = (tree: Tree): string => {
    if (!isSafePath(path)) throw new Fail('unsafe', path);
    const content = tree.get(path);
    if (content === null) throw new Fail('missing', path);
    return content;
  };

  if (obj.command === 'create' && typeof obj.file_text === 'string') {
    const fileText = obj.file_text;
    return (tree: Tree) => {
      if (!isSafePath(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileText);
    };
  }

  if (
    obj.command === 'str_replace' &&
    typeof obj.old_str === 'string' &&
    obj.old_str !== '' &&
    (obj.new_str === undefined || typeof obj.new_str === 'string')
  ) {
    const oldStr = obj.old_str;
    const newStr = (obj.new_str as string | undefined) ?? '';
    return (tree: Tree) => {
      const before = requireExisting(tree);
      const nl = before.indexOf('\n');
      const isCrlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (isCrlf ? s.replaceAll('\r\n', '\n') : s);
      const hay = toLf(before);
      const needle = toLf(oldStr);

      let count = 0;
      let firstPos = -1;
      for (let pos = hay.indexOf(needle); pos >= 0; pos = hay.indexOf(needle, pos + 1)) {
        if (firstPos < 0) firstPos = pos;
        count += 1;
        if (count > 1) break;
      }
      if (count === 0) throw new Fail('no-match', path);
      if (count > 1) throw new Fail('ambiguous', path);

      const replaced = hay.slice(0, firstPos) + toLf(newStr) + hay.slice(firstPos + needle.length);
      tree.now.set(path, isCrlf ? replaced.replaceAll('\n', '\r\n') : replaced);
    };
  }

  if (
    obj.command === 'insert' &&
    typeof obj.insert_line === 'number' &&
    Number.isInteger(obj.insert_line) &&
    typeof obj.new_str === 'string'
  ) {
    const insertLine = obj.insert_line;
    const addLines = patchLines(obj.new_str);
    return (tree: Tree) => {
      const before = requireExisting(tree);
      const file = splitFile(before);
      if (insertLine < 0 || insertLine > file.lines.length) {
        throw new Fail('no-match', path);
      }
      file.lines.splice(insertLine, 0, ...addLines);
      tree.now.set(path, joinFile(file));
    };
  }

  return null;
}

export function parseJsonEdits(text: string, lines: readonly string[]): Edit[] {
  const firstNonBlank = lines.findIndex((l) => !isBlank(l));
  if (firstNonBlank < 0) {
    throw new Exit2('error: parse 1');
  }

  const edits: Edit[] = [];
  if (lines[firstNonBlank]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${firstNonBlank + 1}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Exit2(`error: parse ${firstNonBlank + 1}`);
    }
    for (const item of parsed) {
      const edit = buildJsonEdit(item);
      if (edit === null) {
        throw new Exit2(`error: parse ${firstNonBlank + 1}`);
      }
      edits.push(edit);
    }
    return edits;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (isBlank(line)) continue;
    let edit: Edit | null = null;
    try {
      edit = buildJsonEdit(JSON.parse(line));
    } catch {
      edit = null;
    }
    if (edit === null) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    edits.push(edit);
  }

  return edits;
}
