// git-core-clone: a GitHub-compatible git forge, stdlib only, one process.
//
// Surfaces (see RULES.txt): git smart HTTP at /{owner}/{repo}.git (upload-pack v2,
// receive-pack v0), REST v3 under /api/v3, GraphQL v4 at /api/graphql, MCP at /mcp,
// GET /healthz. Everything is in-memory; one entry process serves one trial.
//
// Scenario (fixed, seed 6a09e667f3bcc909 in the kit's wire.ts): the bearer token names the
// viewer adaiversen (id 1000); teammate quinnkeller (1001); stranger olgabauer (1002);
// org faint-meadow-org. The token is opaque and does not encode the login, so the viewer
// identity is a constant of the scenario, not something parsed out of the token.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0000000000000000000000000000000000000000';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The scenario's viewer: the login the bearer token names. */
const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
const USERS: Record<string, { login: string; id: number; type: string }> = {
  adaiversen: { login: 'adaiversen', id: 1000, type: 'User' },
  quinnkeller: { login: 'quinnkeller', id: 1001, type: 'User' },
  olgabauer: { login: 'olgabauer', id: 1002, type: 'User' },
  'faint-meadow-org': { login: 'faint-meadow-org', id: 2000, type: 'Organization' },
};

// ---------------------------------------------------------------- utilities

let reqCounter = 0;
function requestId(): string {
  reqCounter += 1;
  return `req-${Date.now().toString(36)}-${reqCounter}`;
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `<type> <len>\0<data>`. */
function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}
function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

/** base64url-free opaque global id, e.g. Repository:12 -> base64. */
function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64encode(Buffer.from([kind, ...parts].join(':'), 'utf8'));
}
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

/** Strictly increasing ISO timestamps (monotonic createdAt per resource). */
let lastTs = 0;
function nowIso(): string {
  let ms = Date.now();
  if (ms <= lastTs) ms = lastTs + 1;
  lastTs = ms;
  return new Date(ms).toISOString();
}
function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isOid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': requestId(), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------------------------------------------------------- store

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  data: Buffer;
}
interface Label {
  name: string;
  color: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}
interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Map<number, Issue>;
  issueOrder: Issue[];
  pulls: Map<number, Pull>;
  pullOrder: Pull[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextPullId = 1;
let nextCommentId = 1;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function createRepoRecord(owner: string, name: string, isPrivate: boolean, description: string): Repo {
  const now = nowIso();
  const repo: Repo = {
    id: nextRepoId++,
    name,
    owner,
    private: isPrivate,
    description,
    defaultBranch: 'main',
    createdAt: now,
    updatedAt: now,
    refs: new Map(),
    objects: new Map(),
    issues: new Map(),
    issueOrder: [],
    pulls: new Map(),
    pullOrder: [],
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    seq: ++globalSeq,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: USERS[r.owner]?.id ?? 0, type: USERS[r.owner]?.type ?? 'User' },
    private: r.private,
    description: r.description,
    default_branch: r.defaultBranch,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    html_url: `https://example.invalid/${r.owner}/${r.name}`,
    clone_url: `https://example.invalid/${r.owner}/${r.name}.git`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: i.userLogin, id: USERS[i.userLogin]?.id ?? 0 },
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    comments: i.comments.length,
    html_url: `https://example.invalid/${r.owner}/${r.name}/issues/${i.number}`,
  };
}
function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    head: { ref: p.headRef, sha: p.headSha, label: `${r.owner}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${r.owner}:${p.baseRef}` },
    merged: p.merged,
    merged_at: p.mergedAt,
    merge_commit_sha: p.mergeCommitSha,
    mergeable: computeMergeable(r, p),
    user: { login: p.userLogin, id: USERS[p.userLogin]?.id ?? 0 },
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    html_url: `https://example.invalid/${r.owner}/${r.name}/pull/${p.number}`,
  };
}
function commentJson(c: Comment): Record<string, unknown> {
  return {
    id: c.id,
    body: c.body,
    user: { login: c.userLogin, id: USERS[c.userLogin]?.id ?? 0 },
    created_at: c.createdAt,
  };
}

// ---------------------------------------------------------------- git objects

function storeObject(r: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!r.objects.has(oid)) r.objects.set(oid, { type, data });
  return oid;
}
function getObject(r: Repo, oid: string): GitObject | undefined {
  return r.objects.get(oid);
}

/** Parse a tree object into entries. */
function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const mode = data.subarray(pos, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: names compared bytewise, directories as if ending in '/'. */
function treeSortKey(mode: string, name: string): string {
  return mode === '40000' ? `${name}/` : name;
}
function buildTree(entries: Array<{ mode: string; name: string; oid: string }>): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a.mode, a.name);
    const kb = treeSortKey(b.mode, b.name);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface CommitInfo {
  tree: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  authorTs: number;
  committerName: string;
  committerEmail: string;
  committerTs: number;
  message: string;
}
function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd < 0) return null;
  const head = text.slice(0, headEnd);
  const message = text.slice(headEnd + 2);
  const info: CommitInfo = {
    tree: '',
    parents: [],
    authorName: '',
    authorEmail: '',
    authorTs: 0,
    committerName: '',
    committerEmail: '',
    committerTs: 0,
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const m = /^author (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (m) {
        info.authorName = m[1] ?? '';
        info.authorEmail = m[2] ?? '';
        info.authorTs = Number(m[3]);
      }
    } else if (line.startsWith('committer ')) {
      const m = /^committer (.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
      if (m) {
        info.committerName = m[1] ?? '';
        info.committerEmail = m[2] ?? '';
        info.committerTs = Number(m[3]);
      }
    }
  }
  return info.tree === '' ? null : info;
}

function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

/** Peel a tag object (recursively) to its target commit oid, or the oid itself. */
function peelToCommit(r: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = getObject(r, cur);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})\n/.exec(obj.data.toString('utf8'));
      if (m === null) return null;
      cur = m[1] ?? '';
      continue;
    }
    return null;
  }
  return null;
}

/** All object oids reachable from the given commits (commits, trees, blobs, tags). */
function reachableObjects(r: Repo, starts: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = getObject(r, oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c === null) continue;
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})\n/.exec(obj.data.toString('utf8'));
      if (m !== null) stack.push(m[1] ?? '');
    }
  }
  return out;
}

/** Commits reachable from a tip, newest first (BFS by generation, then timestamp). */
function reachableCommits(r: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(r, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    const c = parseCommit(obj.data);
    if (c !== null) for (const p of c.parents) queue.push(p);
  }
  return out;
}

/** First common ancestor of a and b (both commit oids), or null. */
function mergeBase(r: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set(reachableCommits(r, a));
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = getObject(r, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c !== null) for (const p of c.parents) queue.push(p);
  }
  return null;
}

/** Is `desc` a descendant of (or equal to) `anc`? Both commit oids. Targeted walk: follows parents
 *  from `desc` and stops as soon as `anc` is found, so a linear fast-forward is O(1). */
function isDescendant(r: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(r, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (c === null) continue;
    for (const p of c.parents) {
      if (p === anc) return true;
      stack.push(p);
    }
  }
  return false;
}

/** Flatten a tree to path -> {oid, mode}. */
function flattenTree(r: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = getObject(r, treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(r, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

/** Look a path up in a tree; returns the blob oid or null. */
function lookupPath(r: Repo, treeOid: string, parts: string[]): string | null {
  let cur = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = getObject(r, cur);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return null;
}

/** Replace/add a path in a tree, storing new trees bottom-up; returns the new tree oid. */
function updateTree(r: Repo, treeOid: string | null, parts: string[], blobOid: string | null): string {
  const entries = treeOid === null ? [] : (() => {
    const obj = getObject(r, treeOid);
    return obj !== undefined && obj.type === 'tree' ? parseTree(obj.data) : [];
  })();
  const [head, ...rest] = parts as [string, ...string[]];
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '100644', name: head, oid: blobOid };
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const child = idx >= 0 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
    const newChild = updateTree(r, child, rest, blobOid);
    if (idx >= 0) entries[idx] = { mode: '40000', name: head, oid: newChild };
    else entries.push({ mode: '40000', name: head, oid: newChild });
  }
  return storeObject(r, 'tree', buildTree(entries));
}

// ---------------------------------------------------------------- pkt-lines

function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), body]);
}
function pktFlush(): Buffer {
  return Buffer.from('0000', 'utf8');
}
function pktDelim(): Buffer {
  return Buffer.from('0001', 'utf8');
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}
/** Decode pkt-lines from a buffer; returns packets and the offset where decoding stopped. */
function decodePktLines(buf: Buffer, start = 0): { packets: Pkt[]; offset: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const lenText = buf.subarray(pos, pos + 4).toString('utf8');
    if (lenText === '0000') {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    if (lenText === '0001') {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      pos += 4;
      continue;
    }
    const len = parseInt(lenText, 16);
    if (!Number.isFinite(len) || len < 4 || pos + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return { packets, offset: pos };
}

// ---------------------------------------------------------------- packs

const OBJ_TYPE_NAMES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OBJ_TYPE_CODES: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Apply a git delta to a base buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= (delta[pos] as number) << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= (delta[pos] as number) << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || outLen !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface ParsedPackObject {
  type: ObjType;
  data: Buffer;
  oid: string;
}

/** Parse a packfile; resolves deltas against objects already in the repo and in this pack. */
function parsePack(r: Repo, pack: Buffer): ParsedPackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const objects: ParsedPackObject[] = [];
  const byOid = new Map<string, ParsedPackObject>();
  const pending: Array<{ baseOid: string; delta: Buffer; oidHint: string }> = [];
  const pendingOfs: Array<{ baseOffset: number; delta: Buffer; startOffset: number }> = [];
  const offsetToOid = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    const startOffset = pos;
    let byte = pack[pos] as number;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[pos] as number;
      pos += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === 6) {
      // ofs-delta: negative offset varint
      let offByte = pack[pos] as number;
      pos += 1;
      let offset = offByte & 0x7f;
      while ((offByte & 0x80) !== 0) {
        offByte = pack[pos] as number;
        pos += 1;
        offset = ((offset + 1) << 7) | (offByte & 0x7f);
      }
      const baseOffset = startOffset - offset;
      const inflated = inflateSync(pack.subarray(pos));
      // advance pos past the zlib stream: find its end by inflating incrementally is expensive;
      // instead inflate with a window: use the consumed length via zlib's unused_data trick.
      const consumed = zlibConsumed(pack.subarray(pos), inflated.length);
      pos += consumed;
      pendingOfs.push({ baseOffset, delta: inflated, startOffset });
      void size;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const inflated = inflateSync(pack.subarray(pos));
      const consumed = zlibConsumed(pack.subarray(pos), inflated.length);
      pos += consumed;
      const oidHint = hashObject('blob', inflated);
      pending.push({ baseOid, delta: inflated, oidHint });
      void oidHint;
    } else {
      const type = OBJ_TYPE_NAMES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateSync(pack.subarray(pos));
      const consumed = zlibConsumed(pack.subarray(pos), inflated.length);
      pos += consumed;
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const oid = hashObject(type, inflated);
      const parsed: ParsedPackObject = { type, data: inflated, oid };
      objects.push(parsed);
      byOid.set(oid, parsed);
      offsetToOid.set(startOffset, oid);
    }
  }
  // Resolve ref-deltas (base may be in this pack or already in the repo).
  for (const p of pending) {
    const base = byOid.get(p.baseOid) ?? (() => {
      const o = getObject(r, p.baseOid);
      return o === undefined ? undefined : { type: o.type, data: o.data, oid: p.baseOid };
    })();
    if (base === undefined) throw new Error(`delta base ${p.baseOid} not found`);
    const data = applyDelta(base.data, p.delta);
    const oid = hashObject(base.type, data);
    const parsed: ParsedPackObject = { type: base.type, data, oid };
    objects.push(parsed);
    byOid.set(oid, parsed);
  }
  // Resolve ofs-deltas.
  for (const p of pendingOfs) {
    const baseOid = offsetToOid.get(p.baseOffset);
    if (baseOid === undefined) throw new Error('ofs-delta base offset not found');
    const base = byOid.get(baseOid);
    if (base === undefined) throw new Error('ofs-delta base missing');
    const data = applyDelta(base.data, p.delta);
    const oid = hashObject(base.type, data);
    const parsed: ParsedPackObject = { type: base.type, data, oid };
    objects.push(parsed);
    byOid.set(oid, parsed);
    offsetToOid.set(p.startOffset, oid);
  }
  return objects;
}

/** Bytes consumed by the zlib stream at the start of `buf`, given its inflated length. */
function zlibConsumed(buf: Buffer, inflatedLen: number): number {
  // Binary-search the smallest prefix that inflates to exactly inflatedLen bytes.
  let lo = 1;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const out = inflateSync(buf.subarray(0, mid));
      if (out.length === inflatedLen) hi = mid;
      else if (out.length < inflatedLen) lo = mid + 1;
      else hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Serialize plain objects into a packfile (no deltas), with the SHA-1 trailer. */
function writePack(objects: Array<{ type: ObjType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = OBJ_TYPE_CODES[obj.type];
    const size = obj.data.length;
    const sizeBytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    sizeBytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      sizeBytes.push(b);
    }
    parts.push(Buffer.from(sizeBytes));
    parts.push(deflateSync(obj.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(withoutTrailer), 'hex');
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Split a pack into sideband pkt-lines (band 1). A pkt-line is at most 65520 bytes total, so the
 *  pack data in one line is at most 65520 - 4 (header) - 1 (band byte) = 65515 bytes; use 65510
 *  for margin. */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < pack.length) {
    const chunk = pack.subarray(pos, Math.min(pack.length, pos + 65510));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    pos += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------- fetch computation

/** The commit plus everything reachable from its tree only (no parent traversal). */
function treeObjects(r: Repo, commitOid: string): Set<string> {
  const out = new Set<string>();
  const obj = getObject(r, commitOid);
  if (obj === undefined) return out;
  out.add(commitOid);
  if (obj.type !== 'commit') return out;
  const c = parseCommit(obj.data);
  if (c === null) return out;
  const stack = [c.tree];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const o = getObject(r, oid);
    if (o === undefined) continue;
    out.add(oid);
    if (o.type === 'tree') for (const e of parseTree(o.data)) stack.push(e.oid);
  }
  return out;
}

interface FetchPlan {
  /** Object oids to send, in pack order (commits first, then the rest they reference). */
  send: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
}

/**
 * Compute what a v2 fetch sends. Wants are commit oids (or tag oids, which are sent and peeled
 * for the walk). Haves are commits the client fully holds (their whole history is held);
 * shallows are commits the client holds as shallow boundaries (only the commit and its tree
 * are held — their parents are NOT). With depth N, generations 0..N-1 are sent and the
 * generation N-1 commits (with parents) are the new shallow boundaries; a former shallow
 * boundary whose parent is now sent is unshallow. A held object is never re-sent.
 */
function computeFetch(r: Repo, wants: string[], haves: string[], shallows: string[], depth: number | null): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallows);
  const heldSet = new Set([...haves, ...shallows]);
  // A tag want is sent as an object; the walk starts at the commit it peels to.
  const sendTags = new Set<string>();
  const walkStarts: string[] = [];
  for (const w of wants) {
    const obj = getObject(r, w);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      if (!heldSet.has(w)) sendTags.add(w);
      const commit = peelToCommit(r, w);
      if (commit !== null) walkStarts.push(commit);
    } else if (obj.type === 'commit') {
      walkStarts.push(w);
    }
  }
  // Everything the client already holds: the full closure of haves, and the tree-only
  // closure of shallow boundaries (their parents are unheld by definition). A commit that
  // is BOTH a have and a shallow boundary — the deepen request sends wants=haves=shallow=[tip]
  // — contributes only its tree: its parents are exactly what the deepen must deliver.
  const heldReachable = new Set<string>();
  for (const h of haves) {
    if (shallowSet.has(h)) continue;
    for (const o of reachableObjects(r, [h])) heldReachable.add(o);
  }
  for (const b of shallows) for (const o of treeObjects(r, b)) heldReachable.add(o);
  const genOf = new Map<string, number>();
  const included = new Set<string>();
  const queue: Array<[string, number]> = walkStarts.map((w) => [w, 0] as [string, number]);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (depth !== null && gen >= depth) continue;
    const obj = getObject(r, oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    genOf.set(oid, gen);
    if (!heldSet.has(oid)) included.add(oid);
    // Walk parents unless the client already holds this commit's full history.
    if (haveSet.has(oid) && gen > 0) continue;
    if (haveSet.has(oid) && gen === 0 && depth === null) continue;
    for (const p of commit.parents) queue.push([p, gen + 1]);
  }
  const sendSet = new Set<string>(sendTags);
  for (const c of included) for (const o of treeObjects(r, c)) sendSet.add(o);
  for (const o of heldReachable) sendSet.delete(o);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of genOf) {
      if (gen !== depth - 1) continue;
      const obj = getObject(r, oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      if (commit !== null && commit.parents.length > 0) shallow.push(oid);
    }
  }
  for (const b of shallows) {
    const gen = genOf.get(b);
    if (gen === undefined) continue;
    if (depth !== null && gen >= depth) continue;
    const obj = getObject(r, b);
    if (obj === undefined || obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (commit === null) continue;
    const parentSent = commit.parents.some((p) => sendSet.has(p));
    if (parentSent) unshallow.push(b);
  }
  const acks = haves.filter((h) => getObject(r, h) !== undefined);
  // Pack order: commits first (in generation order), then trees/blobs/tags.
  const commits: string[] = [];
  const rest: string[] = [];
  for (const oid of sendSet) {
    const obj = getObject(r, oid);
    if (obj !== undefined && obj.type === 'commit') commits.push(oid);
    else rest.push(oid);
  }
  commits.sort((a, b) => (genOf.get(a) ?? 0) - (genOf.get(b) ?? 0));
  return { send: [...commits, ...rest], shallow, unshallow, acks };
}

// ---------------------------------------------------------------- mergeability

/** Diff two flattened trees: [{path, status, additions, deletions}]. */
function diffTrees(r: Repo, baseTip: string | null, headTip: string): Array<{ path: string; status: string; additions: number; deletions: number }> {
  const baseMap = new Map<string, { oid: string; mode: string }>();
  const headMap = new Map<string, { oid: string; mode: string }>();
  if (baseTip !== null) {
    const baseCommit = getObject(r, baseTip);
    if (baseCommit !== undefined && baseCommit.type === 'commit') {
      const c = parseCommit(baseCommit.data);
      if (c !== null) flattenTree(r, c.tree, '', baseMap);
    }
  }
  const headCommit = getObject(r, headTip);
  if (headCommit !== undefined && headCommit.type === 'commit') {
    const c = parseCommit(headCommit.data);
    if (c !== null) flattenTree(r, c.tree, '', headMap);
  }
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const out: Array<{ path: string; status: string; additions: number; deletions: number }> = [];
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b !== undefined && h === undefined) {
      const deletions = countLines(r, b.oid);
      out.push({ path, status: 'removed', additions: 0, deletions });
    } else if (b === undefined && h !== undefined) {
      const additions = countLines(r, h.oid);
      out.push({ path, status: 'added', additions, deletions: 0 });
    } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      const { added, removed } = diffLines(r, b.oid, h.oid);
      out.push({ path, status: 'modified', additions: added, deletions: removed });
    }
  }
  return out;
}
function countLines(r: Repo, blobOid: string): number {
  const obj = getObject(r, blobOid);
  if (obj === undefined) return 0;
  const text = obj.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
function diffLines(r: Repo, oldOid: string, newOid: string): { added: number; removed: number } {
  const oldObj = getObject(r, oldOid);
  const newObj = getObject(r, newOid);
  const oldLines = oldObj === undefined ? [] : oldObj.data.toString('utf8').split('\n');
  const newLines = newObj === undefined ? [] : newObj.data.toString('utf8').split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else added += 1;
  }
  let removed = 0;
  for (const c of oldCount.values()) removed += c;
  return { added, removed };
}

/** "MERGEABLE" | "CONFLICTING" | "UNKNOWN" for a pull request. */
function computeMergeable(r: Repo, p: Pull): string {
  if (p.merged) return 'MERGEABLE';
  const baseTip = r.refs.get(`refs/heads/${p.baseRef}`);
  const headTip = r.refs.get(`refs/heads/${p.headRef}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = mergeBase(r, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  const baseCommit = getObject(r, base);
  if (baseCommit === undefined || baseCommit.type !== 'commit') return 'UNKNOWN';
  const baseTree = parseCommit(baseCommit.data)?.tree ?? null;
  if (baseTree === null) return 'UNKNOWN';
  const baseMap = new Map<string, { oid: string; mode: string }>();
  const headMap = new Map<string, { oid: string; mode: string }>();
  const tipMap = new Map<string, { oid: string; mode: string }>();
  flattenTree(r, baseTree, '', baseMap);
  const headCommit = getObject(r, headTip);
  if (headCommit !== undefined && headCommit.type === 'commit') {
    const c = parseCommit(headCommit.data);
    if (c !== null) flattenTree(r, c.tree, '', headMap);
  }
  const tipCommit = getObject(r, baseTip);
  if (tipCommit !== undefined && tipCommit.type === 'commit') {
    const c = parseCommit(tipCommit.data);
    if (c !== null) flattenTree(r, c.tree, '', tipMap);
  }
  for (const path of new Set([...baseMap.keys(), ...headMap.keys(), ...tipMap.keys()])) {
    const b = baseMap.get(path)?.oid;
    const h = headMap.get(path)?.oid;
    const t = tipMap.get(path)?.oid;
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Perform a squash merge; returns the merge commit sha or null when conflicted. */
function squashMerge(r: Repo, p: Pull): string | null {
  if (computeMergeable(r, p) !== 'MERGEABLE') return null;
  const baseTip = r.refs.get(`refs/heads/${p.baseRef}`) as string;
  const headTip = r.refs.get(`refs/heads/${p.headRef}`) as string;
  const headCommit = getObject(r, headTip);
  if (headCommit === undefined || headCommit.type !== 'commit') return null;
  const headInfo = parseCommit(headCommit.data);
  if (headInfo === null) return null;
  const ts = nowSec();
  const message = `Merge pull request #${p.number} from ${r.owner}/${p.headRef}\n\n${p.title}\n`;
  const commitData = buildCommit(headInfo.tree, [baseTip], message, ts);
  const sha = storeObject(r, 'commit', commitData);
  r.refs.set(`refs/heads/${p.baseRef}`, sha);
  return sha;
}

// ---------------------------------------------------------------- git HTTP

const UPLOAD_AD_CT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RES_CT = 'application/x-git-upload-pack-result';
const RECEIVE_AD_CT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RES_CT = 'application/x-git-receive-pack-result';

/** Sorted refs (excluding HEAD) as {oid, ref}. */
function sortedRefs(r: Repo): Array<{ oid: string; ref: string }> {
  return [...r.refs.entries()]
    .map(([ref, oid]) => ({ oid, ref }))
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

function headOid(r: Repo): string | undefined {
  return r.refs.get(`refs/heads/${r.defaultBranch}`);
}

/** v2 capability advertisement for git-upload-pack. */
function advertiseUploadV2(): Buffer {
  const lines = [
    pktLine('# service=git-upload-pack\n'),
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('agent=git-core-clone/1.0\n'),
    pktFlush(),
  ];
  return Buffer.concat(lines);
}

/** v0 ref advertisement for git-upload-pack (or receive-pack with its own caps). */
function advertiseV0(r: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'side-band-64k shallow multi_ack ofs-delta agent=git-core-clone/1.0 symref=HEAD:refs/heads/main'
    : 'report-status side-band-64k delete-refs ofs-delta agent=git-core-clone/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`)];
  const refs = sortedRefs(r);
  const head = headOid(r);
  if (refs.length === 0) {
    // The empty repo's capabilities pseudo-ref carries the capabilities.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (head !== undefined) {
      parts.push(pktLine(first ? `${head} HEAD\0${caps}\n` : `${head} HEAD\n`));
      first = false;
    }
    for (const { oid, ref } of refs) {
      let line = `${oid} ${ref}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      // Peeled annotated tags ride as a second line.
      const obj = getObject(r, oid);
      parts.push(pktLine(`${line}\n`));
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelToCommit(r, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
    if (first) parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** ls-refs (v2): parse the command, answer the ref list with server-side prefix filtering. */
function handleLsRefs(r: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((pfx) => name.startsWith(pfx));
  const parts: Buffer[] = [];
  const head = headOid(r);
  const headTarget = `refs/heads/${r.defaultBranch}`;
  if (keep('HEAD')) {
    if (head !== undefined) {
      parts.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const { oid, ref } of sortedRefs(r)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    const obj = getObject(r, oid);
    if (peel && obj !== undefined && obj.type === 'tag') {
      const peeled = peelToCommit(r, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 fetch: parse the command, answer acknowledgments, shallow-info and the packfile. */
function handleFetchV2(r: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let inArgs = false;
  for (const p of packets) {
    if (p.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  const plan = computeFetch(r, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  // shallow-info
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktDelim());
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  }
  // packfile (omitted entirely when there is nothing to send)
  if (plan.send.length > 0) {
    parts.push(pktDelim());
    parts.push(pktLine('packfile\n'));
    const objects = plan.send.map((oid) => {
      const obj = getObject(r, oid) as GitObject;
      return { type: obj.type, data: obj.data };
    });
    const pack = writePack(objects);
    parts.push(...sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 receive-pack: store the pack, apply ref updates (fast-forward only), report status. */
function handleReceivePack(r: Repo, body: Buffer): Buffer {
  const { packets, offset } = decodePktLines(body);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Cmd[] = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    let line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (m !== null) commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
  }
  const packBytes = body.subarray(offset);
  let unpackOk = true;
  let unpackDetail = '';
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(r, packBytes);
      for (const o of objects) storeObject(r, o.type, o.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = r.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (cmd.oldOid === ZERO_OID || current === undefined) {
          reportLines.push(`ng ${cmd.ref} failed to delete ref\n`);
        } else if (current !== cmd.oldOid) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          r.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const newObj = getObject(r, cmd.newOid);
      if (newObj === undefined) {
        reportLines.push(`ng ${cmd.ref} object not found\n`);
        continue;
      }
      const newCommit = peelToCommit(r, cmd.newOid);
      if (newCommit === null) {
        reportLines.push(`ng ${cmd.ref} object is not a commit\n`);
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          continue;
        }
        r.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (current !== cmd.oldOid) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (!isDescendant(r, cmd.oldOid, newCommit)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      r.refs.set(cmd.ref, cmd.newOid);
      reportLines.push(`ok ${cmd.ref}\n`);
    }
  } else {
    reportLines.push(`unpack ${unpackDetail}\n`);
  }
  // The report-status stream is itself pkt-lined inside band-1 sideband packets.
  const inner = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const outer = sidebandPack(inner);
  return Buffer.concat([...outer, pktFlush()]);
}

// ---------------------------------------------------------------- REST v3

function authed(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function notFound(res: ServerResponse, what = 'Not Found'): void {
  sendJson(res, 404, { message: what });
}

function pageParams(q: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  return { perPage, page };
}

function linkHeader(req: IncomingMessage, basePath: string, q: URLSearchParams, perPage: number, page: number, total: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const url = (p: number): string => {
    const nq = new URLSearchParams(q);
    nq.set('per_page', String(perPage));
    nq.set('page', String(p));
    return `http://${host}${basePath}?${nq.toString()}`;
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${url(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${url(page - 1)}>; rel="prev"`);
  parts.push(`<${url(1)}>; rel="first"`);
  parts.push(`<${url(lastPage)}>; rel="last"`);
  return parts.join(', ');
}

function paginate<T>(items: T[], perPage: number, page: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Resolve a branch name or commit oid to a commit oid, or null. */
function resolveRef(r: Repo, ref: string): string | null {
  const byBranch = r.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (isOid(ref)) {
    const obj = getObject(r, ref);
    if (obj !== undefined && obj.type === 'commit') return ref;
  }
  return null;
}

/** Create an issue in a repo (shared by REST, GraphQL and MCP). */
function createIssueInRepo(r: Repo, title: string, body: string, labelNames: string[]): { issue: Issue } | { error: string } {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = r.labels.get(name);
    if (label === undefined) return { error: `label "${name}" does not exist` };
    labels.push(label);
  }
  const now = nowIso();
  const issue: Issue = {
    id: nextIssueId++,
    number: r.nextIssue++,
    title,
    body,
    state: 'open',
    labels,
    userLogin: VIEWER.login,
    createdAt: now,
    updatedAt: now,
    seq: ++globalSeq,
    comments: [],
  };
  r.issues.set(issue.number, issue);
  r.issueOrder.push(issue);
  return { issue };
}

/** Create a pull request in a repo (shared by REST, GraphQL and MCP). */
function createPullInRepo(r: Repo, title: string, body: string, head: string, base: string): { pull: Pull } | { error: string } {
  const headSha = r.refs.get(`refs/heads/${head}`);
  const baseSha = r.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return { error: `head branch "${head}" does not exist` };
  if (baseSha === undefined) return { error: `base branch "${base}" does not exist` };
  const now = nowIso();
  const pull: Pull = {
    id: nextPullId++,
    number: r.nextPull++,
    title,
    body,
    state: 'open',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    userLogin: VIEWER.login,
    createdAt: now,
    updatedAt: now,
  };
  r.pulls.set(pull.number, pull);
  r.pullOrder.push(pull);
  return { pull };
}

function createCommentInRepo(r: Repo, issue: Issue, body: string): Comment {
  const comment: Comment = {
    id: nextCommentId++,
    body,
    userLogin: VIEWER.login,
    createdAt: nowIso(),
  };
  issue.comments.push(comment);
  return comment;
}

/** Commit a contents change on a branch; creates the branch from the default tip when missing. */
function commitContentsChange(r: Repo, branch: string, message: string, parts: string[], blobOid: string | null): { commitSha: string; created: boolean } {
  let tip = r.refs.get(`refs/heads/${branch}`);
  let created = false;
  if (tip === undefined) {
    tip = r.refs.get(`refs/heads/${r.defaultBranch}`) ?? undefined;
    created = true;
  }
  let treeOid: string | null = null;
  if (tip !== undefined) {
    const commit = getObject(r, tip);
    if (commit !== undefined && commit.type === 'commit') {
      const info = parseCommit(commit.data);
      if (info !== null) treeOid = info.tree;
    }
  }
  const existing = treeOid === null ? null : lookupPath(r, treeOid, parts);
  const newTree = updateTree(r, treeOid, parts, blobOid);
  const parents = tip === undefined ? [] : [tip];
  const commitData = buildCommit(newTree, parents, message, nowSec());
  const commitSha = storeObject(r, 'commit', commitData);
  r.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, created: existing === null };
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[], q: URLSearchParams): Promise<boolean> {
  const method = req.method ?? 'GET';
  // GET /api/v3, /api/v3/
  if (segs.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segs[0] === 'meta' && segs.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (segs[0] === 'user' && segs.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'POST') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, 422, { message: 'Repository already exists' });
        return true;
      }
      const repo = createRepoRecord(VIEWER.login, name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const { perPage, page } = pageParams(q);
      const mine = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const link = linkHeader(req, '/api/v3/user/repos', q, perPage, page, mine.length);
      sendJson(res, 200, paginate(mine, perPage, page).map(repoJson), { link });
      return true;
    }
    return false;
  }
  if (segs[0] === 'orgs' && segs.length === 3 && segs[2] === 'repos' && method === 'POST') {
    const org = decodeSeg(segs[1] as string);
    if (USERS[org]?.type !== 'Organization') {
      notFound(res, 'Organization not found');
      return true;
    }
    const raw = await readBody(req);
    const parsed = parseJsonBody(raw);
    if (!parsed.ok) {
      sendJson(res, 400, { message: 'Invalid JSON body' });
      return true;
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') {
      sendJson(res, 422, { message: 'name is required' });
      return true;
    }
    if (getRepo(org, name) !== undefined) {
      sendJson(res, 422, { message: 'Repository already exists' });
      return true;
    }
    const repo = createRepoRecord(org, name, body.private === true, typeof body.description === 'string' ? body.description : '');
    sendJson(res, 201, repoJson(repo));
    return true;
  }
  if (segs[0] !== 'repos' || segs.length < 3) return false;
  const owner = decodeSeg(segs[1] as string);
  const repoName = decodeSeg(segs[2] as string);
  const repo = getRepo(owner, repoName);
  const rest = segs.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (repo === undefined) {
      notFound(res, 'Repository not found');
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      repo.updatedAt = nowIso();
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, repoName));
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return true;
    }
    return false;
  }

  if (repo === undefined) {
    notFound(res, 'Repository not found');
    return true;
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = sortedRefs(repo)
        .filter((e) => e.ref.startsWith('refs/heads/'))
        .map((e) => ({ name: e.ref.slice('refs/heads/'.length), commit: { sha: e.oid }, protected: false }));
      sendJson(res, 200, list);
      return true;
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeSeg(rest[1] as string);
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        notFound(res, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return true;
    }
    return false;
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = q.get('sha');
    const tip = shaParam === null ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : resolveRef(repo, shaParam);
    if (tip === undefined) {
      sendJson(res, 200, []);
      return true;
    }
    const oids = reachableCommits(repo, tip);
    const entries = oids
      .map((oid, idx) => {
        const obj = getObject(repo, oid);
        const info = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
        return { oid, info, idx };
      })
      .filter((e) => e.info !== null)
      .sort((a, b) => (b.info as CommitInfo).committerTs - (a.info as CommitInfo).committerTs || a.idx - b.idx);
    const { perPage, page } = pageParams(q);
    const list = entries.map(({ oid, info }) => {
      const c = info as CommitInfo;
      return {
        sha: oid,
        commit: {
          message: c.message,
          author: { name: c.authorName, email: c.authorEmail, date: new Date(c.authorTs * 1000).toISOString() },
          committer: { name: c.committerName, email: c.committerEmail, date: new Date(c.committerTs * 1000).toISOString() },
        },
        author: { login: VIEWER.login },
        committer: { login: VIEWER.login },
        parents: c.parents.map((p) => ({ sha: p })),
      };
    });
    sendJson(res, 200, paginate(list, perPage, page));
    return true;
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) {
        sendJson(res, 422, { message: 'ref and sha are required' });
        return true;
      }
      if (getObject(repo, sha) === undefined) {
        sendJson(res, 422, { message: 'sha does not exist in this repository' });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }
    if (method === 'GET' && rest.length >= 3) {
      const refPath = rest.slice(2).map(decodeSeg).join('/');
      const fullRef = `refs/${refPath}`;
      const tip = repo.refs.get(fullRef);
      if (tip === undefined) {
        notFound(res, 'Reference not found');
        return true;
      }
      sendJson(res, 200, { ref: fullRef, object: { sha: tip } });
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const list = sortedRefs(repo).map((e) => ({ ref: e.ref, object: { sha: e.oid } }));
      sendJson(res, 200, list);
      return true;
    }
    return false;
  }

  // contents
  if (rest[0] === 'contents') {
    const pathParts = rest.slice(1).map(decodeSeg).filter((s) => s !== '');
    const refParam = q.get('ref');
    const branch = refParam ?? repo.defaultBranch;
    const tip = resolveRef(repo, branch);
    if (method === 'GET') {
      if (tip === null) {
        notFound(res, 'Not Found');
        return true;
      }
      const commit = getObject(repo, tip);
      const info = commit !== undefined && commit.type === 'commit' ? parseCommit(commit.data) : null;
      if (info === null) {
        notFound(res, 'Not Found');
        return true;
      }
      if (pathParts.length === 0) {
        const entries = parseTree(getObject(repo, info.tree)?.data ?? Buffer.alloc(0)).map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: e.name,
          sha: e.oid,
        }));
        sendJson(res, 200, entries);
        return true;
      }
      // Is the path a directory?
      let curTree = info.tree;
      let isDir = false;
      let dirEntries: Array<{ mode: string; name: string; oid: string }> = [];
      for (let i = 0; i < pathParts.length; i += 1) {
        const obj = getObject(repo, curTree);
        if (obj === undefined || obj.type !== 'tree') {
          notFound(res, 'Not Found');
          return true;
        }
        const entries = parseTree(obj.data);
        const entry = entries.find((e) => e.name === pathParts[i]);
        if (entry === undefined) {
          notFound(res, 'Not Found');
          return true;
        }
        if (i === pathParts.length - 1) {
          if (entry.mode === '40000') {
            isDir = true;
            const dirObj = getObject(repo, entry.oid);
            dirEntries = dirObj !== undefined && dirObj.type === 'tree' ? parseTree(dirObj.data) : [];
          } else {
            const blob = getObject(repo, entry.oid);
            if (blob === undefined) {
              notFound(res, 'Not Found');
              return true;
            }
            sendJson(res, 200, {
              type: 'file',
              encoding: 'base64',
              content: blob.data.toString('base64'),
              sha: entry.oid,
              size: blob.data.length,
              name: entry.name,
              path: pathParts.join('/'),
            });
            return true;
          }
        } else {
          if (entry.mode !== '40000') {
            notFound(res, 'Not Found');
            return true;
          }
          curTree = entry.oid;
        }
      }
      if (isDir) {
        const prefix = pathParts.join('/');
        sendJson(res, 200, dirEntries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name,
          path: `${prefix}/${e.name}`,
          sha: e.oid,
        })));
        return true;
      }
      notFound(res, 'Not Found');
      return true;
    }
    if (method === 'PUT') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      if (contentB64 === '') {
        sendJson(res, 422, { message: 'content is required' });
        return true;
      }
      const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tipBefore = repo.refs.get(`refs/heads/${targetBranch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      let currentBlob: string | null = null;
      if (tipBefore !== undefined) {
        const commit = getObject(repo, tipBefore);
        const info = commit !== undefined && commit.type === 'commit' ? parseCommit(commit.data) : null;
        if (info !== null) currentBlob = lookupPath(repo, info.tree, pathParts);
      }
      if (typeof body.sha === 'string' && body.sha !== '' && currentBlob !== null && body.sha !== currentBlob) {
        sendJson(res, 409, { message: 'sha does not match the current blob' });
        return true;
      }
      const bytes = Buffer.from(contentB64, 'base64');
      const blobOid = storeObject(repo, 'blob', bytes);
      const { commitSha, created } = commitContentsChange(repo, targetBranch, message, pathParts, blobOid);
      sendJson(res, created ? 201 : 200, {
        content: { name: pathParts[pathParts.length - 1] ?? '', path: pathParts.join('/'), sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'Delete file';
      const targetBranch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      const tipBefore = repo.refs.get(`refs/heads/${targetBranch}`);
      if (tipBefore === undefined) {
        notFound(res, 'Not Found');
        return true;
      }
      const commit = getObject(repo, tipBefore);
      const info = commit !== undefined && commit.type === 'commit' ? parseCommit(commit.data) : null;
      if (info === null) {
        notFound(res, 'Not Found');
        return true;
      }
      const currentBlob = lookupPath(repo, info.tree, pathParts);
      if (currentBlob === null) {
        notFound(res, 'Not Found');
        return true;
      }
      if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== currentBlob) {
        sendJson(res, 409, { message: 'sha does not match the current blob' });
        return true;
      }
      const { commitSha } = commitContentsChange(repo, targetBranch, message, pathParts, null);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return true;
    }
    return false;
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (repo.labels.has(name)) {
        sendJson(res, 422, { message: 'Label already exists' });
        return true;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
      const label: Label = { name, color };
      repo.labels.set(name, label);
      sendJson(res, 201, { name, color });
      return true;
    }
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      return true;
    }
    return false;
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendJson(res, 422, { message: 'title is required' });
          return true;
        }
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const l of body.labels) {
            if (typeof l === 'string') labelNames.push(l);
            else if (isRecord(l) && typeof l.name === 'string') labelNames.push(l.name);
          }
        }
        const result = createIssueInRepo(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
        if ('error' in result) {
          sendJson(res, 422, { message: result.error });
          return true;
        }
        sendJson(res, 201, issueJson(repo, result.issue));
        return true;
      }
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? 'asc';
        let list = [...repo.issueOrder];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
        }
        const { perPage, page } = pageParams(q);
        const link = linkHeader(req, `/api/v3/repos/${owner}/${repoName}/issues`, q, perPage, page, list.length);
        sendJson(res, 200, paginate(list, perPage, page).map((i) => issueJson(repo, i)), { link });
        return true;
      }
      return false;
    }
    const num = Number(rest[1]);
    if (!Number.isSafeInteger(num)) return false;
    const issue = repo.issues.get(num);
    if (rest.length === 2) {
      if (issue === undefined) {
        notFound(res, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        issue.updatedAt = nowIso();
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) {
        notFound(res, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return true;
      }
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const commentBody = typeof body.body === 'string' ? body.body : '';
        if (commentBody === '') {
          sendJson(res, 422, { message: 'body is required' });
          return true;
        }
        const comment = createCommentInRepo(repo, issue, commentBody);
        sendJson(res, 201, commentJson(comment));
        return true;
      }
      return false;
    }
    return false;
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const raw = await readBody(req);
        const parsed = parseJsonBody(raw);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Invalid JSON body' });
          return true;
        }
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        if (title === '' || head === '') {
          sendJson(res, 422, { message: 'title and head are required' });
          return true;
        }
        const result = createPullInRepo(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        if ('error' in result) {
          sendJson(res, 422, { message: result.error });
          return true;
        }
        sendJson(res, 201, pullJson(repo, result.pull));
        return true;
      }
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        let list = [...repo.pullOrder];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        const { perPage, page } = pageParams(q);
        sendJson(res, 200, paginate(list, perPage, page).map((p) => pullJson(repo, p)));
        return true;
      }
      return false;
    }
    const num = Number(rest[1]);
    if (!Number.isSafeInteger(num)) return false;
    const pull = repo.pulls.get(num);
    if (rest.length === 2) {
      if (pull === undefined) {
        notFound(res, 'Pull request not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) {
        notFound(res, 'Pull request not found');
        return true;
      }
      const files = diffTrees(repo, pull.baseSha, pull.headSha).map((f) => ({
        filename: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.additions + f.deletions,
      }));
      sendJson(res, 200, files);
      return true;
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) {
        notFound(res, 'Pull request not found');
        return true;
      }
      const raw = await readBody(req);
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Invalid JSON body' });
        return true;
      }
      const body = isRecord(parsed.value) ? parsed.value : {};
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
      if (pull.merged) {
        sendJson(res, 405, { message: 'Pull request already merged' });
        return true;
      }
      if (mergeMethod !== 'squash' && mergeMethod !== 'merge') {
        sendJson(res, 400, { message: `unsupported merge_method "${mergeMethod}"` });
        return true;
      }
      const sha = squashMerge(repo, pull);
      if (sha === null) {
        sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = nowIso();
      pull.mergeCommitSha = sha;
      pull.updatedAt = nowIso();
      sendJson(res, 200, { merged: true, sha, message: `Pull request #${pull.number} merged` });
      return true;
    }
    return false;
  }

  return false;
}

// ---------------------------------------------------------------- GraphQL v4

type GqlValue =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null'; value: null }
  | { kind: 'enum'; value: string }
  | { kind: 'var'; value: string }
  | { kind: 'list'; value: GqlValue[] }
  | { kind: 'object'; value: Record<string, GqlValue> };

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlField[] | null;
  inlineType: string | null;
}
interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: GqlField[];
}

function gqlTokenize(src: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$&():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const text = src.slice(i, j);
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: Array<{ kind: string; value: string }>;
  private readonly fragments: Map<string, GqlField[]>;
  constructor(tokens: Array<{ kind: string; value: string }>, fragments: Map<string, GqlField[]>) {
    this.tokens = tokens;
    this.fragments = fragments;
  }
  private peek(): { kind: string; value: string } {
    return this.tokens[this.pos] as { kind: string; value: string };
  }
  private next(): { kind: string; value: string } {
    const t = this.tokens[this.pos] as { kind: string; value: string };
    this.pos += 1;
    return t;
  }
  private expect(value: string): void {
    const t = this.next();
    if (t.value !== value) throw new Error(`expected ${JSON.stringify(value)}, got ${JSON.stringify(t.value)}`);
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${JSON.stringify(t.value)}`);
    return t.value;
  }

  parseDocument(): GqlOperation[] {
    const ops: GqlOperation[] = [];
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type name
        const sels = this.parseSelections();
        this.fragments.set(name, sels);
        continue;
      }
      let type: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ type, name, selections: this.parseSelections() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        type = t.value as 'query' | 'mutation';
        this.next();
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.skipParens();
        ops.push({ type, name, selections: this.parseSelections() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t.value)} in GraphQL document`);
    }
    return ops;
  }

  private skipParens(): void {
    let depth = 0;
    for (;;) {
      const t = this.next();
      if (t.value === '(') depth += 1;
      else if (t.value === ')') {
        depth -= 1;
        if (depth === 0) return;
      } else if (t.kind === 'eof') return;
    }
  }

  parseSelections(): GqlField[] {
    this.expect('{');
    const out: GqlField[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      out.push(...this.parseField());
    }
    this.expect('}');
    return out;
  }

  private parseField(): GqlField[] {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeName = this.expectName();
        const sels = this.parseSelections();
        return sels.map((s) => ({ ...s, inlineType: typeName }));
      }
      const fragName = this.expectName();
      const frag = this.fragments.get(fragName);
      if (frag === undefined) throw new Error(`unknown fragment ${fragName}`);
      return frag.map((s) => ({ ...s }));
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.expectName();
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect(')');
    }
    let selections: GqlField[] | null = null;
    if (this.peek().value === '{') selections = this.parseSelections();
    return [{ name, alias, args, selections, inlineType: null }];
  }

  private parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: Number(t.value) };
    if (t.kind === 'float') return { kind: 'float', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '$') return { kind: 'var', value: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek().value !== ']') {
        items.push(this.parseValue());
        if (this.peek().value === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek().value !== '}') {
        const key = this.expectName();
        this.expect(':');
        obj[key] = this.parseValue();
        if (this.peek().value === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', value: obj };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null', value: null };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t.value)}`);
  }
}

function evalGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.value];
    case 'list':
      return v.value.map((item) => evalGqlValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, item] of Object.entries(v.value)) out[k] = evalGqlValue(item, vars);
      return out;
    }
    default:
      return v.value;
  }
}

interface GqlNode {
  __type: string;
  [k: string]: unknown;
}
function repoNode(r: Repo): GqlNode {
  return { __type: 'Repository', __repo: r };
}
function issueNode(r: Repo, i: Issue): GqlNode {
  return { __type: 'Issue', __repo: r, __issue: i };
}
function pullNode(r: Repo, p: Pull): GqlNode {
  return { __type: 'PullRequest', __repo: r, __pull: p };
}
function userNode(login: string): GqlNode {
  return { __type: 'User', __login: login };
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

function gqlState(issueState: 'open' | 'closed'): string {
  return issueState === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field of a node; returns the raw value (scalar, node, array, or connection node). */
function resolveGqlField(node: GqlNode, field: GqlField, vars: Record<string, unknown>): unknown {
  const type = node.__type;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field.args)) args[k] = evalGqlValue(v, vars);

  if (type === 'Query') {
    if (field.name === 'viewer') return userNode(VIEWER.login);
    if (field.name === 'repository') {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const r = getRepo(owner, name);
      return r === undefined ? null : repoNode(r);
    }
    if (field.name === 'node') {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const r = [...repos.values()].find((x) => x.id === Number(parsed.parts[0]));
        return r === undefined ? null : repoNode(r);
      }
      if (parsed.kind === 'Issue') {
        const r = [...repos.values()].find((x) => x.id === Number(parsed.parts[0]));
        const issue = r?.issues.get(Number(parsed.parts[1]));
        return r !== undefined && issue !== undefined ? issueNode(r, issue) : null;
      }
      if (parsed.kind === 'PullRequest') {
        const r = [...repos.values()].find((x) => x.id === Number(parsed.parts[0]));
        const pull = r?.pulls.get(Number(parsed.parts[1]));
        return r !== undefined && pull !== undefined ? pullNode(r, pull) : null;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = typeof args.name === 'string' ? args.name : '';
      return { __type: '__Type', __typeName: name } as GqlNode;
    }
    if (field.name === '__schema') {
      return { __type: '__Schema' } as GqlNode;
    }
    return undefined;
  }
  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(repoId);
      const r = parsed !== null && parsed.kind === 'Repository' ? [...repos.values()].find((x) => x.id === Number(parsed.parts[0])) : undefined;
      if (r === undefined) return null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const result = createIssueInRepo(r, title, body, []);
      if ('error' in result) return null;
      return { __type: 'CreateIssuePayload', __issue: result.issue, __repo: r } as GqlNode;
    }
    if (field.name === 'closeIssue') {
      const input = isRecord(args.input) ? args.input : {};
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const parsed = parseGlobalId(issueId);
      const r = parsed !== null && parsed.kind === 'Issue' ? [...repos.values()].find((x) => x.id === Number(parsed.parts[0])) : undefined;
      const issue = r?.issues.get(Number(parsed?.parts[1] ?? NaN));
      if (r === undefined || issue === undefined) return null;
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      return { __type: 'CloseIssuePayload', __issue: issue, __repo: r } as GqlNode;
    }
    if (field.name === 'createPullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const repoId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const parsed = parseGlobalId(repoId);
      const r = parsed !== null && parsed.kind === 'Repository' ? [...repos.values()].find((x) => x.id === Number(parsed.parts[0])) : undefined;
      if (r === undefined) return null;
      const result = createPullInRepo(
        r,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : 'main',
      );
      if ('error' in result) return null;
      return { __type: 'CreatePullRequestPayload', __pull: result.pull, __repo: r } as GqlNode;
    }
    if (field.name === 'mergePullRequest') {
      const input = isRecord(args.input) ? args.input : {};
      const prId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const parsed = parseGlobalId(prId);
      const r = parsed !== null && parsed.kind === 'PullRequest' ? [...repos.values()].find((x) => x.id === Number(parsed.parts[0])) : undefined;
      const pull = r?.pulls.get(Number(parsed?.parts[1] ?? NaN));
      if (r === undefined || pull === undefined) return null;
      if (!pull.merged) {
        const sha = squashMerge(r, pull);
        if (sha !== null) {
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = nowIso();
          pull.mergeCommitSha = sha;
          pull.updatedAt = nowIso();
        }
      }
      return { __type: 'MergePullRequestPayload', __pull: pull, __repo: r } as GqlNode;
    }
    if (field.name === 'addComment') {
      const input = isRecord(args.input) ? args.input : {};
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const parsed = parseGlobalId(subjectId);
      const r = parsed !== null && parsed.kind === 'Issue' ? [...repos.values()].find((x) => x.id === Number(parsed.parts[0])) : undefined;
      const issue = r?.issues.get(Number(parsed?.parts[1] ?? NaN));
      if (r === undefined || issue === undefined) return null;
      const comment = createCommentInRepo(r, issue, typeof input.body === 'string' ? input.body : '');
      return { __type: 'AddCommentPayload', __comment: comment, __repo: r } as GqlNode;
    }
    return undefined;
  }
  if (type === 'User') {
    const login = node.__login as string;
    if (field.name === 'login') return login;
    if (field.name === 'id') return USERS[login]?.id ?? 0;
    if (field.name === 'name') return login === VIEWER.login ? VIEWER.name : login;
    if (field.name === 'email') return login === VIEWER.login ? VIEWER.email : `${login}@example.invalid`;
    return undefined;
  }
  if (type === 'Repository') {
    const r = node.__repo as Repo;
    if (field.name === 'id') return globalId('Repository', r.id);
    if (field.name === 'databaseId') return r.id;
    if (field.name === 'name') return r.name;
    if (field.name === 'nameWithOwner') return `${r.owner}/${r.name}`;
    if (field.name === 'owner') return userNode(r.owner);
    if (field.name === 'defaultBranchRef') return { __type: 'BranchRef', __name: r.defaultBranch } as GqlNode;
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const n = typeof args.number === 'number' ? args.number : -1;
      const issue = r.issues.get(n);
      return issue === undefined ? null : issueNode(r, issue);
    }
    if (field.name === 'issues') return issuesConnection(r, args);
    if (field.name === 'pullRequest') {
      const n = typeof args.number === 'number' ? args.number : -1;
      const pull = r.pulls.get(n);
      return pull === undefined ? null : pullNode(r, pull);
    }
    if (field.name === 'pullRequests') return pullsConnection(r, args);
    return undefined;
  }
  if (type === 'BranchRef') {
    if (field.name === 'name') return node.__name as string;
    return undefined;
  }
  if (type === 'Issue') {
    const i = node.__issue as Issue;
    const r = node.__repo as Repo;
    if (field.name === 'id') return globalId('Issue', r.id, i.number);
    if (field.name === 'number') return i.number;
    if (field.name === 'title') return i.title;
    if (field.name === 'state') return gqlState(i.state);
    if (field.name === 'body') return i.body;
    return undefined;
  }
  if (type === 'PullRequest') {
    const p = node.__pull as Pull;
    const r = node.__repo as Repo;
    if (field.name === 'id') return globalId('PullRequest', r.id, p.number);
    if (field.name === 'number') return p.number;
    if (field.name === 'title') return p.title;
    if (field.name === 'state') return p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'headRefName') return p.headRef;
    if (field.name === 'baseRefName') return p.baseRef;
    if (field.name === 'mergeable') return computeMergeable(r, p);
    if (field.name === 'merged') return p.merged;
    if (field.name === 'files') {
      const first = typeof args.first === 'number' ? args.first : 10;
      const files = diffTrees(r, p.baseSha, p.headSha).slice(0, first);
      return {
        __type: 'PullRequestFileConnection',
        __nodes: files.map((f) => ({ __type: 'PullRequestFile', __path: f.path, __status: f.status, __additions: f.additions, __deletions: f.deletions })),
      } as GqlNode;
    }
    return undefined;
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestFileConnection') {
    if (field.name === 'nodes') return node.__nodes as GqlNode[];
    if (field.name === 'edges') return (node.__nodes as GqlNode[]).map((n) => ({ __type: 'Edge', __node: n }) as GqlNode);
    if (field.name === 'pageInfo') return node.__pageInfo as GqlNode;
    if (field.name === 'totalCount') return (node.__nodes as GqlNode[]).length;
    return undefined;
  }
  if (type === 'Edge') {
    if (field.name === 'node') return node.__node as GqlNode;
    return undefined;
  }
  if (type === 'PageInfo') {
    if (field.name === 'hasNextPage') return node.__hasNextPage as boolean;
    if (field.name === 'endCursor') return node.__endCursor as string | null;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'startCursor') return node.__startCursor as string | null;
    return undefined;
  }
  if (type === 'PullRequestFile') {
    if (field.name === 'path') return node.__path as string;
    if (field.name === 'additions') return node.__additions as number;
    if (field.name === 'deletions') return node.__deletions as number;
    if (field.name === 'status') return node.__status as string;
    return undefined;
  }
  if (type === '__Type') {
    const name = node.__typeName as string;
    if (field.name === 'name') return name;
    if (field.name === 'fields') {
      const names = GQL_TYPE_FIELDS[name] ?? [];
      return names.map((n) => ({ __type: '__Field', __name: n }) as GqlNode);
    }
    if (field.name === 'enumValues') {
      const values = GQL_ENUM_VALUES[name];
      if (values === undefined) return null;
      return values.map((n) => ({ __type: '__EnumValue', __name: n }) as GqlNode);
    }
    return undefined;
  }
  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return node.__name as string;
    return undefined;
  }
  if (type === '__Schema') {
    if (field.name === 'queryType') return { __type: '__Type', __typeName: 'Query' } as GqlNode;
    if (field.name === 'mutationType') return { __type: '__Type', __typeName: 'Mutation' } as GqlNode;
    if (field.name === 'types') return [];
    return undefined;
  }
  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') return issueNode(node.__repo as Repo, node.__issue as Issue);
    return undefined;
  }
  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') return pullNode(node.__repo as Repo, node.__pull as Pull);
    return undefined;
  }
  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const c = node.__comment as Comment;
      const r = node.__repo as Repo;
      return {
        __type: 'CommentEdge',
        __node: { __type: 'IssueComment', __id: globalId('IssueComment', r.id, c.id), __body: c.body } as GqlNode,
      } as GqlNode;
    }
    return undefined;
  }
  if (type === 'CommentEdge') {
    if (field.name === 'node') return node.__node as GqlNode;
    return undefined;
  }
  if (type === 'IssueComment') {
    if (field.name === 'id') return node.__id as string;
    if (field.name === 'body') return node.__body as string;
    return undefined;
  }
  return undefined;
}

function issuesConnection(r: Repo, args: Record<string, unknown>): GqlNode {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let list = [...r.issueOrder];
  if (states !== null) {
    const want = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    list = list.filter((i) => want.has(i.state));
  }
  list.sort((a, b) => (direction === 'desc' ? b.seq - a.seq : a.seq - b.seq));
  const first = typeof args.first === 'number' ? args.first : list.length;
  let afterNum: number | null = null;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      afterNum = Number(b64decode(args.after).toString('utf8'));
    } catch {
      afterNum = null;
    }
  }
  if (afterNum !== null) {
    list = direction === 'desc' ? list.filter((i) => i.number < afterNum) : list.filter((i) => i.number > afterNum);
  }
  const page = list.slice(0, first);
  const hasNext = list.length > page.length;
  const endCursor = page.length > 0 ? b64encode(Buffer.from(String(page[page.length - 1]?.number ?? ''), 'utf8')) : null;
  return {
    __type: 'IssueConnection',
    __nodes: page.map((i) => issueNode(r, i)),
    __pageInfo: { __type: 'PageInfo', __hasNextPage: hasNext, __endCursor: endCursor, __startCursor: null } as GqlNode,
  } as GqlNode;
}

function pullsConnection(r: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : r.pullOrder.length;
  const page = r.pullOrder.slice(0, first);
  const hasNext = r.pullOrder.length > page.length;
  return {
    __type: 'PullRequestConnection',
    __nodes: page.map((p) => pullNode(r, p)),
    __pageInfo: { __type: 'PageInfo', __hasNextPage: hasNext, __endCursor: null, __startCursor: null } as GqlNode,
  } as GqlNode;
}

/** Execute a selection set against a node; returns the JSON value plus any errors. */
function executeSelections(node: GqlNode, selections: GqlField[], vars: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> | null {
  const data: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.inlineType !== null && field.inlineType !== node.__type) continue;
    const key = field.alias ?? field.name;
    const value = resolveGqlField(node, field, vars);
    if (value === undefined) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${node.__type}"` });
      data[key] = null;
      continue;
    }
    if (field.selections === null) {
      data[key] = value;
      continue;
    }
    if (value === null) {
      data[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      data[key] = value.map((item) => {
        if (item !== null && typeof item === 'object' && '__type' in (item as Record<string, unknown>)) {
          const subErrors: Array<{ message: string }> = [];
          const sub = executeSelections(item as GqlNode, field.selections as GqlField[], vars, subErrors);
          if (subErrors.length > 0) {
            errors.push(...subErrors);
            return null;
          }
          return sub;
        }
        return item;
      });
      continue;
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      const subErrors: Array<{ message: string }> = [];
      const sub = executeSelections(value as GqlNode, field.selections as GqlField[], vars, subErrors);
      if (subErrors.length > 0) {
        errors.push(...subErrors);
        data[key] = null;
      } else {
        data[key] = sub;
      }
      continue;
    }
    data[key] = value;
  }
  return data;
}

function executeGraphQL(query: string, vars: Record<string, unknown>): Record<string, unknown> {
  const parser = new GqlParser(gqlTokenize(query), new Map());
  const ops = parser.parseDocument();
  if (ops.length === 0) return { data: null, errors: [{ message: 'Empty GraphQL document' }] };
  const op = ops[0] as GqlOperation;
  const root: GqlNode = { __type: op.type === 'mutation' ? 'Mutation' : 'Query' };
  const errors: Array<{ message: string }> = [];
  const data = executeSelections(root, op.selections, vars, errors);
  if (errors.length > 0) return { data, errors };
  return { data };
}

async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'A GraphQL query is required' }] };
    const vars = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    try {
      return executeGraphQL(doc.query, vars);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(body));
}

// ---------------------------------------------------------------- v0 fetch

/** v0 fetch: wants + shallow/deepen, flush, haves + done, flush. Answers NAK/ACK lines, shallow lines, then the sideband pack. */
function handleFetchV0(r: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') {
      section += 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isSafeInteger(n) && n > 0) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
  }
  const plan = computeFetch(r, wants, haves, shallows, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (plan.send.length > 0) {
    const objects = plan.send.map((oid) => {
      const obj = getObject(r, oid) as GitObject;
      return { type: obj.type, data: obj.data };
    });
    parts.push(...sidebandPack(writePack(objects)));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- MCP

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (defaults to the viewer)' },
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        issue_number: { type: 'integer', description: 'Issue number' },
        number: { type: 'integer', description: 'Issue number' },
      },
      required: [],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'owner/repo' },
        issue_number: { type: 'integer', description: 'Issue number' },
        number: { type: 'integer', description: 'Issue number' },
      },
      required: [],
    },
  },
];

function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [owner, repo] = args.full_name.split('/', 2);
    const found = getRepo(owner as string, repo as string);
    if (found !== undefined) return found;
  }
  const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (repo === '') return null;
  return getRepo(owner, repo) ?? null;
}

function mcpToolResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}
function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const required: Record<string, string[]> = {
    create_repo: ['name'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const missing = (required[name] ?? []).filter((k) => args[k] === undefined || args[k] === '');
  if (missing.length > 0) return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
  if (name === 'create_repo') {
    const repoName = args.name as string;
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : VIEWER.login;
    if (getRepo(owner, repoName) !== undefined) return mcpToolError(`repository ${owner}/${repoName} already exists`);
    const repo = createRepoRecord(owner, repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return mcpToolResult(repoJson(repo));
  }
  const repo = mcpResolveRepo(args);
  if (repo === null) return mcpToolError('repository not found');
  if (name === 'get_repo') return mcpToolResult(repoJson(repo));
  if (name === 'create_issue') {
    const result = createIssueInRepo(repo, args.title as string, typeof args.body === 'string' ? args.body : '', []);
    if ('error' in result) return mcpToolError(result.error);
    return mcpToolResult(issueJson(repo, result.issue));
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...repo.issueOrder];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    return mcpToolResult(list.map((i) => issueJson(repo, i)));
  }
  if (name === 'create_pull_request') {
    const result = createPullInRepo(
      repo,
      args.title as string,
      typeof args.body === 'string' ? args.body : '',
      args.head as string,
      args.base as string,
    );
    if ('error' in result) return mcpToolError(result.error);
    return mcpToolResult(pullJson(repo, result.pull));
  }
  if (name === 'merge_pull_request') {
    const num = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : -1;
    const pull = repo.pulls.get(num);
    if (pull === undefined) return mcpToolError(`pull request #${num} not found`);
    if (pull.merged) return mcpToolError(`pull request #${num} is already merged`);
    const sha = squashMerge(repo, pull);
    if (sha === null) return mcpToolError(`pull request #${num} has a merge conflict`);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = nowIso();
    return mcpToolResult({ number: pull.number, merged: true, state: 'closed', sha, merge_commit_sha: sha });
  }
  if (name === 'get_issue') {
    const num = typeof args.issue_number === 'number' ? args.issue_number : typeof args.number === 'number' ? args.number : -1;
    const issue = repo.issues.get(num);
    if (issue === undefined) return mcpToolError(`issue #${num} not found`);
    return mcpToolResult(issueJson(repo, issue));
  }
  if (name === 'close_issue') {
    const num = typeof args.issue_number === 'number' ? args.issue_number : typeof args.number === 'number' ? args.number : -1;
    const issue = repo.issues.get(num);
    if (issue === undefined) return mcpToolError(`issue #${num} not found`);
    issue.state = 'closed';
    issue.updatedAt = nowIso();
    return mcpToolResult(issueJson(repo, issue));
  }
  return mcpToolError(`unknown tool ${name}`);
}

function mcpRpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    mcpRpcError(res, null, -32700, 'Parse error', 400);
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    mcpRpcError(res, isRecord(body) ? body.id : null, -32600, 'Invalid Request', 400);
    return;
  }
  const id = body.id ?? null;
  const method = body.method;
  const params = isRecord(body.params) ? body.params : {};
  const result = (value: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  if (id === null || id === undefined) {
    // A notification (e.g. notifications/initialized): 202, no body.
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'server/discover') {
    result({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: 'git-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-core-clone', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : '2025-11-25';
    result({
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'git-core-clone', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const known = MCP_TOOLS.some((t) => t.name === toolName);
    if (!known) {
      mcpRpcError(res, id, -32602, `unknown tool ${toolName}`);
      return;
    }
    result(callMcpTool(toolName, args));
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  mcpRpcError(res, id, -32601, `method not found: ${method}`);
}

// ---------------------------------------------------------------- router

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP: Streamable HTTP at /mcp. Auth required for POST.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          await handleMcp(req, res);
          return;
        }

        // GraphQL v4. Auth required; unauthenticated is exactly 401.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          await handleGraphQL(req, res);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const segs = path.slice('/api/v3'.length).split('/').filter((s) => s !== '');
          const handled = await handleRest(req, res, segs, queryOf(req));
          if (!handled) sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Git smart HTTP at /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeSeg(gitMatch[1] as string);
          const repoName = decodeSeg(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          if (!authed(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const repo = getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Repository not found' });
            return;
          }
          if (method === 'GET' && tail === 'info/refs') {
            const service = queryOf(req).get('service');
            if (service === 'git-upload-pack') {
              const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
              sendRaw(res, 200, UPLOAD_AD_CT, v2 ? advertiseUploadV2() : advertiseV0(repo, 'git-upload-pack'));
              return;
            }
            if (service === 'git-receive-pack') {
              sendRaw(res, 200, RECEIVE_AD_CT, advertiseV0(repo, 'git-receive-pack'));
              return;
            }
            sendJson(res, 400, { message: 'service is required' });
            return;
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            const body = await readBody(req);
            const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            if (v2) {
              const { packets } = decodePktLines(body);
              const first = packets.find((p) => p.kind === 'data');
              const firstLine = first === undefined ? '' : first.payload.toString('utf8').replace(/\n$/, '');
              if (firstLine === 'command=ls-refs') {
                sendRaw(res, 200, UPLOAD_RES_CT, handleLsRefs(repo, body));
                return;
              }
              if (firstLine === 'command=fetch') {
                sendRaw(res, 200, UPLOAD_RES_CT, handleFetchV2(repo, body));
                return;
              }
              sendJson(res, 400, { message: 'unknown git-upload-pack command' });
              return;
            }
            // v0 fetch.
            sendRaw(res, 200, UPLOAD_RES_CT, handleFetchV0(repo, body));
            return;
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            const body = await readBody(req);
            sendRaw(res, 200, RECEIVE_RES_CT, handleReceivePack(repo, body));
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash the server on a bad request; answer 500 JSON and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
        } catch {
          try {
            res.end();
          } catch {
            // The socket is already gone.
          }
        }
      }
    })();
  });
}
