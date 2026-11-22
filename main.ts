// mend: one patch tool for every AI edit format, built to SPEC.md (version 1).
//
// main.ts is the CLI the grader runs as `node main.ts [options] [PATCH]`. It reads a patch in any of the four
// formats models write (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), finds the lines each edit
// names at the first of three matching tiers (exact, trailing-whitespace-insensitive, fully whitespace-trimmed),
// and writes every change or none. The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines plus its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, final: fin };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Lines of a file an edit creates: LF breaks, a final break unless the format says otherwise. */
function createdText(lines: string[], finalBreak: boolean): string {
  return lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : '');
}

// Section 5: the three matching tiers. Only spaces and tabs are ever trimmed.
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  return tier === 0 ? a === b : tier === 1 ? trimTrail(a) === trimTrail(b) : trimBoth(a) === trimBoth(b);
}

/** Every start position at or after `from` where O occurs in lines at this tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): Found | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions = occurrences(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** At tier 2 a new line that starts with the old block's indent P takes the file's own indent F instead. */
function reindent(t: string, f: string, p: string): string {
  if (t === '' || t.trim() === '') return t;
  return t.startsWith(p) ? f + t.slice(p.length) : t;
}

/** One body entry of a unified hunk or a V4A chunk: a context, old or new line. */
interface Ent {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  bsAfter: boolean;
  emptyRaw: boolean;
  blankRaw: boolean;
}

/**
 * The lines a matched block is replaced by: context lines are the file's own matched lines, `-` lines drop out,
 * `+` lines are written as they are except for the tier-2 re-indent. Returns the new segment.
 */
function buildSegment(fileLines: string[], pos: number, entries: Ent[], tier: number): string[] {
  const out: string[] = [];
  const firstOld = entries.find((e) => e.kind !== 'new');
  const f = leadWS(fileLines[pos] ?? '');
  const p = firstOld ? leadWS(firstOld.text) : '';
  let fi = pos;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(fileLines[fi]!);
      fi += 1;
    } else if (e.kind === 'old') {
      fi += 1;
    } else {
      out.push(tier === 2 ? reindent(e.text, f, p) : e.text);
    }
  }
  return out;
}

/** Fold `\` body lines into a bsAfter flag on the entry before them, and drop them from the list. */
function foldBackslash(raw: { kind: Ent['kind'] | 'bs'; text: string; emptyRaw: boolean }[]): Ent[] {
  const out: Ent[] = [];
  for (const e of raw) {
    if (e.kind === 'bs') {
      const prev = out[out.length - 1];
      if (prev) prev.bsAfter = true;
    } else {
      out.push({ kind: e.kind, text: e.text, bsAfter: false, emptyRaw: e.emptyRaw, blankRaw: false });
    }
  }
  return out;
}

/** Whether a `\` line follows the body's last context or `+` line (SPEC.md section 6's final-break rule). */
function lastLineBroken(entries: Ent[]): boolean {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]!.kind !== 'old') return entries[i]!.bsAfter;
  }
  return false;
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const m = splitFile(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(m));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

interface UHunk {
  a: number;
  entries: Ent[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Apply one section's hunks in order to a file model; d is the running line drift of the section. */
function applyHunks(m: FileModel, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const entries = hunk.entries;
    const oLen = entries.filter((e) => e.kind !== 'new').length;
    const nLen = entries.filter((e) => e.kind !== 'old').length;
    if (oLen > 0) {
      const o = entries.filter((e) => e.kind !== 'new').map((e) => e.text);
      const found = findTier(m.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = hunk.a - 1 + d;
      let pos = found.positions[0]!;
      let best = Math.abs(pos - target);
      for (const cand of found.positions) {
        const dist = Math.abs(cand - target);
        if (dist < best) {
          best = dist;
          pos = cand;
        }
      }
      const touchesEnd = pos + oLen === m.lines.length;
      const seg = buildSegment(m.lines, pos, entries, found.tier);
      m.lines.splice(pos, oLen, ...seg);
      if (touchesEnd) m.final = !lastLineBroken(entries);
    } else {
      const add = entries.filter((e) => e.kind === 'new').map((e) => e.text);
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > m.lines.length) at = m.lines.length;
      const touchesEnd = at === m.lines.length;
      m.lines.splice(at, 0, ...add);
      if (touchesEnd) m.final = !lastLineBroken(entries);
    }
    d += nLen - oLen;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let raw: { kind: Ent['kind'] | 'bs'; text: string; emptyRaw: boolean }[] | null = null;
  let rawA = 0;

  const endBody = (): void => {
    if (raw === null || cur === null) return;
    while (raw.length > 0 && raw[raw.length - 1]!.emptyRaw) raw.pop();
    cur.hunks.push({ a: rawA, entries: foldBackslash(raw) });
    raw = null;
  };
  const newSection = (): USection => {
    endBody();
    const s: USection = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const next = lines[i + 1] ?? '';
    if (raw !== null) {
      // Inside a hunk body: a `diff --git ` line, or a `--- `/`+++ ` pair, ends the body first.
      const pairAhead = line.startsWith('--- ') && next.startsWith('+++ ');
      if (!line.startsWith('diff --git ') && !pairAhead) {
        if (line === '') {
          raw.push({ kind: 'ctx', text: '', emptyRaw: true });
          continue;
        }
        const c = line[0]!;
        if (c === ' ') {
          raw.push({ kind: 'ctx', text: line.slice(1), emptyRaw: false });
          continue;
        }
        if (c === '-') {
          raw.push({ kind: 'old', text: line.slice(1), emptyRaw: false });
          continue;
        }
        if (c === '+') {
          raw.push({ kind: 'new', text: line.slice(1), emptyRaw: false });
          continue;
        }
        if (c === '\\') {
          raw.push({ kind: 'bs', text: '', emptyRaw: false });
          continue;
        }
      }
      endBody();
    }
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0 || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = rest.slice(2, sep);
      s.gitNew = rest.slice(sep + 3);
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next.startsWith('+++ ')) {
        if (cur !== null && cur.hunks.length === 0 && cur.pairOld === null && raw === null) {
          cur.pairOld = headerPath(line);
          cur.pairNew = headerPath(next);
        } else {
          const s = newSection();
          s.pairOld = headerPath(line);
          s.pairNew = headerPath(next);
        }
        i += 1;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      raw = [];
      rawA = Number.parseInt(m[1]!, 10);
      continue;
    }
    if (cur !== null && cur.hunks.length === 0 && raw === null) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    // Every other line outside a body is ignored: prose, fences, index and mode lines.
  }
  endBody();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.pairOld !== null ? stripPrefix(s.pairOld) : s.renameFrom ?? s.gitOld;
    const newP = s.pairNew !== null ? stripPrefix(s.pairNew) : s.renameTo ?? s.gitNew;
    const hunks = s.hunks;
    if (oldP === '/dev/null' || s.newFile) {
      const target = newP ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) !== null) throw new Fail('exists', target);
        const out: string[] = [];
        let broken = false;
        for (const h of hunks) {
          for (const e of h.entries) {
            if (e.kind === 'new') {
              out.push(e.text);
              broken = e.bsAfter;
            }
          }
        }
        tree.now.set(target, createdText(out, !broken));
      });
    } else if (newP === '/dev/null' || s.delFile) {
      const target = oldP ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        if (tree.get(target) === null) throw new Fail('missing', target);
        tree.now.set(target, null);
      });
    } else if (oldP !== null && newP !== null && oldP !== newP) {
      const from = oldP;
      const to = newP;
      edits.push((tree) => {
        if (!safe(from)) throw new Fail('unsafe', from);
        if (!safe(to)) throw new Fail('unsafe', to);
        const before = tree.get(from);
        if (before === null) throw new Fail('missing', from);
        if (tree.get(to) !== null) throw new Fail('exists', to);
        const m = splitFile(before);
        applyHunks(m, hunks, strict, from);
        tree.now.set(to, joinFile(m));
        tree.now.set(from, null);
        tree.moves.push([from, to]);
      });
    } else {
      const target = oldP ?? newP ?? '';
      edits.push((tree) => {
        if (!safe(target)) throw new Fail('unsafe', target);
        const before = tree.get(target);
        if (before === null) throw new Fail('missing', target);
        const m = splitFile(before);
        applyHunks(m, hunks, strict, target);
        tree.now.set(target, joinFile(m));
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let eq = -1;
    for (let k = i + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let k = eq + 1; k < lines.length; k += 1) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map((b): Edit => {
    const { path, oldLines, newLines } = b;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(newLines, true));
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const m = splitFile(before);
      const found = findTier(m.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0]!;
      const f = leadWS(m.lines[pos]!);
      const p = leadWS(oldLines[0]!);
      const seg = newLines.map((t) => (found.tier === 2 ? reindent(t, f, p) : t));
      m.lines.splice(pos, oldLines.length, ...seg);
      tree.now.set(path, joinFile(m));
    };
  });
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Ent[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  line: number;
  content: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let chunk: VChunk | null = null;
  let addRaw: { line: string; num: number }[] = [];

  const endAdd = (): void => {
    if (cur === null || cur.kind !== 'add') return;
    // Blank lines at the end of a section are not part of it (blank: empty or only whitespace, section 4).
    while (addRaw.length > 0 && addRaw[addRaw.length - 1]!.line.trim() === '') addRaw.pop();
    cur.content = addRaw.map(({ line, num }) => {
      if (line === '') return '';
      if (line.startsWith('+')) return line.slice(1);
      throw new Exit2(`error: parse ${num}`);
    });
    addRaw = [];
  };
  const endUpdate = (): void => {
    if (cur === null || cur.kind !== 'upd') return;
    // Blank lines at the end of a section are not part of it: trim the last chunk's trailing empty lines,
    // and drop a chunk nothing but those blanks made.
    const tail = cur.chunks[cur.chunks.length - 1];
    if (tail) {
      while (tail.entries.length > 0 && tail.entries[tail.entries.length - 1]!.kind === 'ctx' && tail.entries[tail.entries.length - 1]!.blankRaw) tail.entries.pop();
      if (tail.entries.length === 0 && tail.anchor === null && !tail.eof) cur.chunks.pop();
    }
    if (cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
  };
  const endSection = (): void => {
    endAdd();
    endUpdate();
    chunk = null;
  };

  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      endSection();
      if (line.startsWith('*** Add File: ')) {
        cur = { kind: 'add', path: line.slice(13).trim(), line: i + 1, content: [], moveTo: null, chunks: [] };
        addRaw = [];
      } else if (line.startsWith('*** Delete File: ')) {
        cur = { kind: 'del', path: line.slice(16).trim(), line: i + 1, content: [], moveTo: null, chunks: [] };
      } else {
        cur = { kind: 'upd', path: line.slice(16).trim(), line: i + 1, content: [], moveTo: null, chunks: [] };
      }
      sections.push(cur);
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'add') {
      addRaw.push({ line, num: i + 1 });
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // Update File section.
    if (line.startsWith('*** Move to: ')) {
      if (cur.moveTo !== null || cur.chunks.length > 0) throw new Exit2(`error: parse ${i + 1}`);
      cur.moveTo = line.slice(13).trim();
      continue;
    }
    if (line === '*** End of File') {
      if (chunk === null) {
        chunk = { anchor: null, eof: true, entries: [] };
        cur.chunks.push(chunk);
      } else {
        chunk.eof = true;
      }
      chunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      chunk = { anchor: line.slice(2).trim() || null, eof: false, entries: [] };
      cur.chunks.push(chunk);
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (chunk === null) {
        chunk = { anchor: null, eof: false, entries: [] };
        cur.chunks.push(chunk);
      }
      if (line === '') chunk.entries.push({ kind: 'ctx', text: '', bsAfter: false, emptyRaw: true, blankRaw: true });
      else if (line[0] === ' ') chunk.entries.push({ kind: 'ctx', text: line.slice(1), bsAfter: false, emptyRaw: false, blankRaw: line.trim() === '' });
      else if (line[0] === '-') chunk.entries.push({ kind: 'old', text: line.slice(1), bsAfter: false, emptyRaw: false, blankRaw: false });
      else chunk.entries.push({ kind: 'new', text: line.slice(1), bsAfter: false, emptyRaw: false, blankRaw: false });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  endSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    const { path } = s;
    if (s.kind === 'add') {
      const content = s.content;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(content, true));
      });
    } else if (s.kind === 'del') {
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const chunks = s.chunks;
      const moveTo = s.moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        const m = splitFile(before);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let at = -1;
            for (const tier of strict ? [0] : [0, 1, 2]) {
              for (let k = cursor; k < m.lines.length; k += 1) {
                if (lineEq(m.lines[k]!, ch.anchor, tier)) {
                  at = k;
                  break;
                }
              }
              if (at >= 0) break;
            }
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const o = ch.entries.filter((e) => e.kind !== 'new').map((e) => e.text);
          if (o.length > 0) {
            let hit: Found | null = null;
            for (const tier of strict ? [0] : [0, 1, 2]) {
              let positions = occurrences(m.lines, o, tier, cursor);
              if (ch.eof) positions = positions.filter((p) => p + o.length === m.lines.length);
              if (positions.length > 0) {
                hit = { tier, positions };
                break;
              }
            }
            if (hit === null) throw new Fail('no-match', path);
            const pos = hit.positions[0]!;
            const seg = buildSegment(m.lines, pos, ch.entries, hit.tier);
            m.lines.splice(pos, o.length, ...seg);
            cursor = pos + seg.length;
          } else {
            const add = ch.entries.filter((e) => e.kind === 'new').map((e) => e.text);
            const at = ch.eof ? m.lines.length : cursor;
            m.lines.splice(at, 0, ...add);
            cursor = at + add.length;
          }
        }
        const text = joinFile(m);
        if (moveTo !== null) {
          tree.now.set(moveTo, text);
          tree.now.set(path, null);
          tree.moves.push([path, moveTo]);
        } else {
          tree.now.set(path, text);
        }
      });
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the run, the all-or-nothing write.

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };

  // Changed paths, with a successful move shown as one R line that sorts by its new path.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const moveMap = new Map<string, string>();
  for (const [o, n] of tree.moves) if (!moveMap.has(o)) moveMap.set(o, n);
  const paired = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o] of tree.moves) {
    if (paired.has(o)) continue;
    let end = o;
    const seen = new Set<string>([o]);
    while (moveMap.has(end)) {
      const nxt = moveMap.get(end)!;
      if (seen.has(nxt)) break;
      seen.add(nxt);
      end = nxt;
      if (tree.original(end) !== null || tree.now.get(end) !== null) break;
    }
    if (end !== o && tree.original(o) !== null && tree.now.get(o) === null && tree.original(end) === null && tree.now.get(end) !== null && !paired.has(end)) {
      paired.add(o);
      paired.add(end);
      for (const step of seen) paired.add(step);
      rows.push({ key: end, line: `R ${o} -> ${end}` });
    }
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
