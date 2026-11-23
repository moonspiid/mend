// mend is the CLI SPEC.md specifies (version 1). SPEC.md is the whole contract: sections 1 to 10.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.

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

/** Section 3: a file's line break and its lines. */
function parseText(text: string): { lines: string[]; finalBreak: boolean; br: string } {
  if (text === '') return { lines: [], finalBreak: false, br: '\n' };
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  return { lines: ends ? parts.slice(0, -1) : parts, finalBreak: ends, br };
}

const trimT = (l: string): string => l.replace(/[ \t]+$/, '');
const trimBoth = (l: string): string => l.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leading = (l: string): string => /^[ \t]*/.exec(l)![0];

/** Section 5: the occurrences of O in lines, at one tier. */
function occurrencesAt(lines: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      const a = lines[i + j]!;
      const b = O[j]!;
      const eq = tier === 0 ? a === b : tier === 1 ? trimT(a) === trimT(b) : trimBoth(a) === trimBoth(b);
      if (!eq) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

function firstTierOccurrences(lines: string[], O: string[], strict?: boolean): { tier: number; occs: number[] } | null {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const occs = occurrencesAt(lines, O, tier);
    if (occs.length > 0) return { tier, occs };
  }
  return null;
}

/** Section 3: the tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---------------------------------------------------------------------------
// Section 6: unified diffs.

interface HunkEntry { kind: 'context' | 'old' | 'new' | 'marker'; text: string; raw: string; }
interface Hunk { A: number; body: HunkEntry[]; }
interface UnifiedSection {
  viaDiff: boolean;
  diffOld: string;
  diffNew: string;
  sawPair: boolean;
  pairOld: string;
  pairNew: string;
  renameFrom: string | null;
  renameTo: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

function pathAfterPrefix(line: string): string {
  let p = line.slice(4);
  const t = p.indexOf('\t');
  if (t >= 0) p = p.slice(0, t);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function hunkEntry(line: string): HunkEntry {
  if (line === '') return { kind: 'context', text: '', raw: line };
  const c = line[0]!;
  if (c === ' ') return { kind: 'context', text: line.slice(1), raw: line };
  if (c === '-') return { kind: 'old', text: line.slice(1), raw: line };
  if (c === '+') return { kind: 'new', text: line.slice(1), raw: line };
  return { kind: 'marker', text: line.slice(1), raw: line };
}

function readHunkBody(lines: string[], i: number, hunk: Hunk): number {
  while (i < lines.length) {
    const line = lines[i]!;
    if (i + 1 < lines.length && line.startsWith('--- ') && lines[i + 1]!.startsWith('+++ ')) break;
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
      hunk.body.push(hunkEntry(line));
      i += 1;
    } else {
      break;
    }
  }
  while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.raw === '') hunk.body.pop();
  return i;
}

function readUnifiedSectionBody(lines: string[], i: number, section: UnifiedSection): number {
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { A: parseInt(m[1]!, 10), body: [] };
      i = readHunkBody(lines, i + 1, hunk);
      section.hunks.push(hunk);
    } else if (line.startsWith('diff --git ')) {
      return i;
    } else if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
        if (section.hunks.length > 0) return i;
        section.sawPair = true;
        section.pairOld = pathAfterPrefix(line);
        section.pairNew = pathAfterPrefix(lines[i + 1]!);
        i += 2;
      } else {
        throw new Exit2(`error: parse ${i + 2 <= lines.length ? i + 2 : i + 1}`);
      }
    } else if (line.startsWith('rename from ')) {
      section.renameFrom = line.slice('rename from '.length).trim();
      i += 1;
    } else if (line.startsWith('rename to ')) {
      section.renameTo = line.slice('rename to '.length).trim();
      i += 1;
    } else if (line.startsWith('new file mode')) {
      section.newFileMode = true;
      i += 1;
    } else if (line.startsWith('deleted file mode')) {
      section.deletedFileMode = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  return i;
}

function parseUnified(lines: string[]): UnifiedSection[] {
  const edits: UnifiedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const section: UnifiedSection = {
        viaDiff: true, diffOld: m[1]!, diffNew: m[2]!, sawPair: false, pairOld: '', pairNew: '',
        renameFrom: null, renameTo: null, newFileMode: false, deletedFileMode: false, hunks: [],
      };
      i = readUnifiedSectionBody(lines, i + 1, section);
      edits.push(section);
    } else if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      const section: UnifiedSection = {
        viaDiff: false, diffOld: pathAfterPrefix(line), diffNew: pathAfterPrefix(lines[i + 1]!),
        sawPair: true, pairOld: pathAfterPrefix(line), pairNew: pathAfterPrefix(lines[i + 1]!),
        renameFrom: null, renameTo: null, newFileMode: false, deletedFileMode: false, hunks: [],
      };
      i = readUnifiedSectionBody(lines, i + 2, section);
      edits.push(section);
    } else {
      i += 1;
    }
  }
  return edits;
}

function sectionPaths(s: UnifiedSection): { oldPath: string | null; newPath: string | null } {
  const un = (p: string): string | null => (p === '/dev/null' ? null : p);
  const oldPath = s.sawPair ? un(s.pairOld) : (s.renameFrom !== null ? un(s.renameFrom) : un(s.diffOld));
  const newPath = s.sawPair ? un(s.pairNew) : (s.renameTo !== null ? un(s.renameTo) : un(s.diffNew));
  return { oldPath, newPath };
}

function lastNewEntry(hunks: Hunk[]): { hunk: Hunk; idx: number } | null {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h]!.body;
    for (let k = body.length - 1; k >= 0; k--) if (body[k]!.kind === 'new') return { hunk: hunks[h]!, idx: k };
  }
  return null;
}

function applyUnifiedSection(section: UnifiedSection, tree: Tree, moves: Array<[string, string]>, strict: boolean): void {
  const { oldPath, newPath } = sectionPaths(section);
  for (const p of [oldPath, newPath].filter((p): p is string => p !== null)) if (!safe(p)) throw new Fail('unsafe', p);
  const isCreation = section.newFileMode || oldPath === null;
  const isDeletion = section.deletedFileMode || newPath === null;
  if (isCreation) {
    const target = newPath ?? oldPath;
    if (target === null) throw new Fail('unsafe', '');
    if (tree.get(target) !== null) throw new Fail('exists', target);
    const fileLines: string[] = [];
    for (const hunk of section.hunks) for (const e of hunk.body) if (e.kind === 'new') fileLines.push(e.text);
    const last = lastNewEntry(section.hunks);
    const endsBreak = last === null ? true : !(last.idx + 1 < last.hunk.body.length && last.hunk.body[last.idx + 1]!.kind === 'marker');
    tree.now.set(target, fileLines.length > 0 ? fileLines.join('\n') + (endsBreak ? '\n' : '') : '');
    return;
  }
  if (isDeletion) {
    if (oldPath === null) throw new Fail('missing', newPath ?? '');
    if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
    tree.now.set(oldPath, null);
    return;
  }
  const isMove = oldPath !== null && newPath !== null && oldPath !== newPath;
  const target = newPath ?? oldPath!;
  if (isMove) {
    if (tree.get(oldPath) === null) throw new Fail('missing', oldPath!);
    if (tree.get(newPath) !== null) throw new Fail('exists', newPath!);
  }
  const readPath = isMove ? oldPath! : target;
  const text = tree.get(readPath);
  if (text === null) throw new Fail('missing', readPath);
  const { lines, finalBreak, br } = parseText(text);
  let fileLines = lines.slice();
  let d = 0;
  let finalMarker = false;
  for (const hunk of section.hunks) {
    const O: string[] = [];
    for (const e of hunk.body) if (e.kind === 'context' || e.kind === 'old') O.push(e.text);
    let pos: number;
    let tier = 0;
    if (O.length > 0) {
      const found = firstTierOccurrences(fileLines, O, strict);
      if (!found) throw new Fail('no-match', readPath);
      const targetPos = hunk.A - 1 + d;
      let best = found.occs[0]!;
      let bestDist = Math.abs(best - targetPos);
      for (const p of found.occs) {
        const dist = Math.abs(p - targetPos);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      pos = best;
      tier = found.tier;
    } else {
      const insertAt = hunk.A + d;
      pos = fileLines.length < insertAt ? fileLines.length : insertAt;
    }
    const F = tier > 0 && O.length > 0 ? leading(fileLines[pos]) : '';
    const P = tier > 0 && O.length > 0 ? leading(O[0]) : '';
    const out: string[] = [];
    let oi = pos;
    for (const e of hunk.body) {
      if (e.kind === 'context') { out.push(fileLines[oi]!); oi += 1; }
      else if (e.kind === 'new') {
        let t = e.text;
        if (tier > 0 && O.length > 0 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
        out.push(t);
      } else if (e.kind === 'old') { oi += 1; }
    }
    const touchesEnd = O.length > 0 ? pos + O.length === fileLines.length : pos === fileLines.length;
    if (touchesEnd) {
      for (let k = hunk.body.length - 1; k >= 0; k--) {
        const e = hunk.body[k]!;
        if (e.kind === 'context' || e.kind === 'new') {
          if (k + 1 < hunk.body.length && hunk.body[k + 1]!.kind === 'marker') finalMarker = true;
          break;
        }
      }
    }
    fileLines = fileLines.slice(0, pos).concat(out, fileLines.slice(oi));
    d += out.length - O.length;
  }
  const newText = fileLines.length === 0 ? '' : fileLines.join(br) + ((finalMarker ? false : finalBreak) ? br : '');
  if (isMove) {
    tree.now.set(newPath!, newText);
    tree.now.set(oldPath!, null);
    moves.push([oldPath!, newPath!]);
  } else {
    tree.now.set(target, newText);
  }
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.

interface SrEdit { path: string; oldLines: string[]; newLines: string[]; }

function parseSearchReplace(lines: string[]): SrEdit[] {
  const edits: SrEdit[] = [];
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && lines[i]!.trimEnd() !== '<<<<<<< SEARCH') i += 1;
    if (i >= lines.length) break;
    const searchIdx = i;
    let prevReplace = -1;
    for (let k = searchIdx - 1; k >= 0; k--) if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { prevReplace = k; break; }
    const regionStart = prevReplace + 1;
    let pathIdx = -1;
    for (let k = searchIdx - 1; k >= regionStart; k--) {
      const t = lines[k]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      pathIdx = k;
      break;
    }
    let path: string | null;
    if (pathIdx >= 0) {
      path = lines[pathIdx]!.trim();
      prevPath = path;
    } else {
      path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') { eqIdx = k; break; }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    if (eqIdx < 0) { i = searchIdx + 1; continue; }
    let repIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k++) if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { repIdx = k; break; }
    if (repIdx < 0) { i = searchIdx + 1; continue; }
    edits.push({ path, oldLines: lines.slice(searchIdx + 1, eqIdx), newLines: lines.slice(eqIdx + 1, repIdx) });
    i = repIdx + 1;
  }
  return edits;
}

function applySrEdit(edit: SrEdit, tree: Tree): void {
  const p = edit.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  const text = tree.get(p);
  if (edit.oldLines.length === 0) {
    if (text !== null) throw new Fail('exists', p);
    tree.now.set(p, edit.newLines.length > 0 ? edit.newLines.join('\n') + '\n' : '');
    return;
  }
  if (text === null) throw new Fail('missing', p);
  const { lines, finalBreak, br } = parseText(text);
  const found = firstTierOccurrences(lines, edit.oldLines);
  if (!found) throw new Fail('no-match', p);
  if (found.occs.length !== 1) throw new Fail('ambiguous', p);
  const pos = found.occs[0]!;
  const F = found.tier > 0 && edit.oldLines.length > 0 ? leading(lines[pos]) : '';
  const P = edit.oldLines.length > 0 ? leading(edit.oldLines[0]) : '';
  const newLines = edit.newLines.map((l) => (found.tier > 0 && l.trim() !== '' && l.startsWith(P) ? F + l.slice(P.length) : l));
  const newFileLines = lines.slice(0, pos).concat(newLines, lines.slice(pos + edit.oldLines.length));
  tree.now.set(p, newFileLines.length === 0 ? '' : newFileLines.join(br) + (finalBreak ? br : ''));
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.

interface V4aEntry { kind: 'context' | 'old' | 'new'; text: string; raw: string; }
interface V4aChunk { anchor: string | null; endOfFile: boolean; body: V4aEntry[]; }
interface V4aAdd { kind: 'add'; path: string; lines: string[]; }
interface V4aDelete { kind: 'delete'; path: string; }
interface V4aUpdate { kind: 'update'; path: string; moveTo: string | null; chunks: V4aChunk[]; }
type V4aSection = V4aAdd | V4aDelete | V4aUpdate;

function v4aEntry(line: string): V4aEntry {
  if (line === '') return { kind: 'context', text: '', raw: line };
  const c = line[0]!;
  if (c === ' ') return { kind: 'context', text: line.slice(1), raw: line };
  if (c === '-') return { kind: 'old', text: line.slice(1), raw: line };
  return { kind: 'new', text: line.slice(1), raw: line };
}

function isV4aBodyLine(l: string): boolean {
  return l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+';
}

function isV4aSectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

function isEndPatch(l: string): boolean {
  return l.trim() === '*** End Patch';
}

function readV4aChunkBody(lines: string[], i: number, chunk: V4aChunk): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (isV4aSectionStart(l) || isEndPatch(l)) return i;
    if (l.startsWith('@@')) return i;
    if (l.trim() === '*** End of File') { chunk.endOfFile = true; return i + 1; }
    if (isV4aBodyLine(l)) { chunk.body.push(v4aEntry(l)); i += 1; continue; }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return i;
}

function parseV4a(lines: string[]): V4aSection[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < n) {
    const line = lines[i]!;
    if (blank(line)) { i += 1; continue; }
    if (isEndPatch(line)) break;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (isV4aSectionStart(l) || isEndPatch(l)) break;
        if (l === '' || l.startsWith('+')) { body.push(l); i += 1; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sections.push({ kind: 'add', path, lines: body.map((l) => (l === '' ? '' : l.slice(1))) });
    } else if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < n) {
        const l = lines[i]!;
        if (isV4aSectionStart(l) || isEndPatch(l)) break;
        if (l !== '') throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      sections.push({ kind: 'delete', path });
    } else if (line.startsWith('*** Update File: ')) {
      const sectionLine = i;
      const path = line.slice('*** Update File: '.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < n && lines[i]!.trimStart().startsWith('*** Move to: ')) {
        moveTo = lines[i]!.trimStart().slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (isV4aSectionStart(l) || isEndPatch(l)) break;
        if (l.startsWith('@@')) {
          const chunk: V4aChunk = { anchor: l.slice(2).trim(), endOfFile: false, body: [] };
          chunks.push(chunk);
          i = readV4aChunkBody(lines, i + 1, chunk);
        } else if (chunks.length === 0 && isV4aBodyLine(l)) {
          const chunk: V4aChunk = { anchor: null, endOfFile: false, body: [] };
          chunks.push(chunk);
          i = readV4aChunkBody(lines, i, chunk);
        } else if (l.trim() === '*** End of File' && chunks.length > 0) {
          chunks[chunks.length - 1]!.endOfFile = true;
          i += 1;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionLine + 1}`);
      if (chunks.length > 0) {
        const last = chunks[chunks.length - 1]!;
        while (last.body.length > 0 && last.body[last.body.length - 1]!.raw.trim() === '') last.body.pop();
      }
      sections.push({ kind: 'update', path, moveTo, chunks });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections;
}

function equalAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimT(a) === trimT(b);
  return trimBoth(a) === trimBoth(b);
}

function applyV4aUpdate(sec: V4aUpdate, tree: Tree, moves: Array<[string, string]>): void {
  const p = sec.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
  if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
  const text = tree.get(p);
  if (text === null) throw new Fail('missing', p);
  const { lines, finalBreak, br } = parseText(text);
  let fileLines = lines.slice();
  let cursor = 0;
  for (const chunk of sec.chunks) {
    const O = chunk.body.filter((e) => e.kind !== 'new').map((e) => e.text);
    let pos = -1;
    let matchTier = -1;
    if (chunk.anchor !== null) {
      let found = false;
      for (let tier = 0; tier <= 2 && !found; tier++) {
        for (let i = cursor; i < fileLines.length; i++) {
          if (equalAtTier(fileLines[i]!, chunk.anchor!, tier)) { pos = i + 1; found = true; break; }
        }
      }
      if (!found) throw new Fail('no-match', p);
      cursor = pos;
    }
    if (O.length === 0) {
      pos = chunk.endOfFile ? fileLines.length : cursor;
    } else {
      let found = false;
      for (let tier = 0; tier <= 2 && !found; tier++) {
        const occs = occurrencesAt(fileLines, O, tier).filter((pp) => pp >= cursor);
        if (chunk.endOfFile) {
          const eoccs = occs.filter((pp) => pp + O.length === fileLines.length);
          if (eoccs.length > 0) { pos = eoccs[0]!; found = true; matchTier = tier; }
        } else if (occs.length > 0) { pos = occs[0]!; found = true; matchTier = tier; }
      }
      if (!found) throw new Fail('no-match', p);
    }
    const F = O.length > 0 && matchTier > 0 ? leading(fileLines[pos]) : '';
    const P = O.length > 0 ? leading(O[0]) : '';
    const out: string[] = [];
    let oi = pos;
    for (const e of chunk.body) {
      if (e.kind === 'new') {
        let t = e.text;
        if (O.length > 0 && matchTier > 0 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
        out.push(t);
      } else if (e.kind === 'context') { out.push(fileLines[oi]!); oi += 1; }
      else oi += 1;
    }
    fileLines = fileLines.slice(0, pos).concat(out, fileLines.slice(oi));
    cursor = pos + out.length;
  }
  const newText = fileLines.length === 0 ? '' : fileLines.join(br) + (finalBreak ? br : '');
  if (sec.moveTo !== null) {
    tree.now.set(sec.moveTo, newText);
    tree.now.set(p, null);
    moves.push([p, sec.moveTo]);
  } else {
    tree.now.set(p, newText);
  }
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): ((tree: Tree) => void) | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Array<(tree: Tree) => void> {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Array<(tree: Tree) => void> = [];
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
    let e: ((tree: Tree) => void) | null = null;
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
// Sections 1, 2, 4, 10 (with 5 shared, above).

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

type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

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
  const moves: Array<[string, string]> = [];
  let edits: Array<(tree: Tree, moves: Array<[string, string]>) => void>;
  try {
    if (kind === 'json') edits = jsonEdits(text, lines).map((e): Edit => (tree) => e(tree));
    else if (kind === 'unified') edits = parseUnified(lines).map((s): Edit => (tree) => applyUnifiedSection(s, tree, moves, strict));
    else if (kind === 'search-replace')
      edits = parseSearchReplace(lines).map((e): Edit => (tree) => applySrEdit(e, tree));
    else
      edits = parseV4a(lines).map((s): Edit => {
        if (s.kind === 'add')
          return (tree) => {
            if (!safe(s.path)) throw new Fail('unsafe', s.path);
            if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
            tree.now.set(s.path, s.lines.length > 0 ? s.lines.join('\n') + '\n' : '');
          };
        if (s.kind === 'delete')
          return (tree) => {
            if (!safe(s.path)) throw new Fail('unsafe', s.path);
            if (tree.get(s.path) === null) throw new Fail('missing', s.path);
            tree.now.set(s.path, null);
          };
        return (tree) => applyV4aUpdate(s, tree, moves);
      });
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ path: string; text: string }> = [];
  const movedOlds = new Set<string>();
  const movedNews = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      movedOlds.add(oldP);
      movedNews.add(newP);
      rows.push({ path: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of tree.now.keys()) {
    if (tree.now.get(p) === tree.original(p)) continue;
    if (movedOlds.has(p) || movedNews.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ path: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const out = rows.map((r) => r.text);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out };
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
