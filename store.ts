// The forge's store: one in-memory model shared by the git, REST, GraphQL and MCP
// surfaces, so a commit pushed over git is the same commit REST lists, and an issue
// created over GraphQL is the same issue REST reads back.
//
// Nothing here reads a clock or Math.random: commit timestamps come from a fixed epoch
// plus a per-repository sequence, so two runs that receive the same requests in the same
// order build the same objects, byte for byte.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** Fixed epoch for server-made commits: 2025-01-01T00:00:00Z, plus a per-repo sequence. */
export const EPOCH_SEC = 1735689600;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 id of a git object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------
// git object views
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  const buf = Buffer.from(data);
  while (offset < buf.length) {
    const space = buf.indexOf(0x20, offset);
    const nul = buf.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > buf.length) break;
    const mode = buf.subarray(offset, space).toString('utf8');
    const name = buf.subarray(space + 1, nul).toString('utf8');
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object into its headers and message. */
export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a tree object from entries, sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Build a commit object. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  timestamp: number;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  // A blank line separates the headers from the message (two empty elements so the
  // join ends with "\n\n"); without it parseCommit finds no message at all.
  lines.push('', '');
  const head = lines.join('\n');
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(fields.message, 'utf8')]);
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

function readPackVarint(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  let byte = buf[start] ?? 0;
  let size = byte & 0x0f;
  const typeCode = (byte >> 4) & 0x07;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    offset += 1;
  }
  return { size, typeCode, next: offset };
}

function readDeltaOffset(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start] ?? 0;
  let offset = start;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    offset += 1;
    byte = buf[offset] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { baseOffset: value, next: offset + 1 };
}

/** Apply a git delta to its base, following the delta instruction stream. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos++] ?? 0;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size does not match its base');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++] ?? 0;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) offset |= (delta[pos++] ?? 0) << (bit * 8);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) size |= (delta[pos++] ?? 0) << (bit * 8);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta instruction 0 is invalid');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile (v2/v3), resolving ofs-delta and ref-delta entries. */
export function readPack(pack: Uint8Array): PackReadResult {
  const buf = Buffer.from(pack);
  if (buf.length < 32) throw new Error('pack is too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailerStart = buf.length - 20;
  const trailer = buf.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackVarint(buf, offset);
    offset = header.next;
    const entry: Raw = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readDeltaOffset(buf, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
      if (entry.baseOffset < 0) throw new Error('ofs-delta base offset is negative');
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateSync(buf.subarray(offset, trailerStart));
    if (inflated.length !== header.size) throw new Error('pack entry inflated size mismatch');
    entry.data = inflated;
    // Advance past the deflated bytes: re-inflate with a streaming reader is overkill; find the
    // end by trying inflateSync on increasing slices is wrong, so use zlib's unused_data via
    // inflateSync on the remainder and measure consumed length through a second pass.
    offset = skipDeflate(buf, offset, trailerStart);
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, Raw>();
  let deltaCount = 0;
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    try {
      let type: GitObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        deltaCount += 1;
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        deltaCount += 1;
        const wanted = entry.baseOid ?? '';
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry) {
          const base = resolve(baseEntry);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          throw new Error(`ref-delta base ${wanted} is not in the pack`);
        }
      } else {
        type = CODE_TYPE[entry.typeCode] as GitObjectType;
        data = entry.data;
      }
      const oid = hashObject(type, data);
      resolvedByOid.set(oid, entry);
      return { type, data, oid };
    } finally {
      resolving.delete(entry.offset);
    }
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

/** Find where a zlib stream starting at `start` ends, using inflateSync's unused_data. */
function skipDeflate(buf: Buffer, start: number, end: number): number {
  // inflateSync throws on truncated input; binary-search the smallest prefix that inflates.
  let low = start;
  let high = end;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buf.subarray(start, mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): PACK, version 2, count, entries, SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

/** All object ids reachable from `tips` through commits, trees and tags. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
  options: { maxCommitDepth?: number; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) stack.push({ oid: tip, depth: 1 });
  while (stack.length > 0) {
    const { oid, depth } = stack.pop() as { oid: string; depth: number };
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      if (!seen.has(view.tree)) stack.push({ oid: view.tree, depth });
      // The depth limit stops parent traversal only: a commit at the limit still
      // contributes its tree and blobs, which is what a shallow fetch needs.
      if (options.maxCommitDepth !== undefined && depth >= options.maxCommitDepth) continue;
      // A shallow boundary is held by the client, but its parents are not.
      if (options.stopAt !== undefined && options.stopAt.has(oid)) continue;
      for (const parent of view.parents) {
        if (!seen.has(parent)) stack.push({ oid: parent, depth: depth + 1 });
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (!seen.has(entry.oid)) stack.push({ oid: entry.oid, depth });
      }
    } else if (object.type === 'tag') {
      const view = parseTag(object.data);
      if (!seen.has(view.object)) stack.push({ oid: view.object, depth });
    }
  }
  return seen;
}

/** The commit ids reachable from `tip`, with their generation (tip = 1). */
export function commitGenerations(tip: string, lookup: (oid: string) => GitObject | undefined): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 1 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    if (generations.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    generations.set(oid, depth);
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return generations;
}

// ---------------------------------------------------------------------------
// file maps and trees
// ---------------------------------------------------------------------------

/** Flatten a tree object into path -> {oid, mode} for every file below it. */
export function treeFileMap(
  treeOid: string,
  lookup: (oid: string) => GitObject | undefined,
): Map<string, { oid: string; mode: string }> {
  const files = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = lookup(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return files;
}

/** Build tree objects from a flat file map, storing new trees into `put`. Returns the root tree oid. */
export function buildTreeFromFiles(
  files: ReadonlyMap<string, { oid: string; mode: string }>,
  put: (type: GitObjectType, data: Buffer) => string,
): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const makeNode = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = makeNode();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = makeNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return put('tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: IssueComment[];
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  commitSeq: number;
  createdSeq: number;
}

let globalIdCounter = 5000;
let globalSeq = 0;

export function nextGlobalId(): number {
  globalIdCounter += 1;
  return globalIdCounter;
}

export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

export class Store {
  /** The viewer login, learned from the first owner named in a repo-addressed request. */
  viewerLogin: string | null = null;
  readonly repos = new Map<string, Repo>();
  private readonly repoOrder: Repo[] = [];

  /** Learn the viewer login from an owner segment; first one wins. */
  learnViewer(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  viewer(): string {
    return this.viewerLogin ?? 'viewer';
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: nextGlobalId(),
      name,
      owner: null,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      commitSeq: 0,
      createdSeq: nextSeq(),
    };
    this.repos.set(name, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  /** All repositories in creation order. */
  allRepos(): Repo[] {
    return [...this.repoOrder];
  }

  /** Look a repository up by the owner named in the request: binds the owner lazily on first
   *  access, and answers undefined for any other owner (a 404, never a 403). */
  lookupRepo(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    this.learnViewer(owner);
    if (repo.owner === null) repo.owner = owner;
    if (repo.owner !== owner) return undefined;
    return repo;
  }

  /** A repository by name alone, regardless of owner (used only for global-id decoding). */
  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    const index = this.repoOrder.indexOf(repo);
    if (index >= 0) this.repoOrder.splice(index, 1);
    return true;
  }

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip commit's timestamp, or the fixed epoch when the repo has no commits. */
  tipTimestamp(repo: Repo, branch: string): number {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return EPOCH_SEC;
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return EPOCH_SEC;
    const author = parseCommit(object.data).author;
    const match = / (\d+) \+0000$/.exec(author);
    return match !== null ? Number(match[1]) : EPOCH_SEC;
  }

  /** Create a commit on a branch from a flat file map. */
  commitFiles(
    repo: Repo,
    branch: string,
    files: ReadonlyMap<string, { oid: string; mode: string }>,
    message: string,
  ): string {
    const treeOid = buildTreeFromFiles(files, (type, data) => this.putObject(repo, type, data));
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parents = tip === undefined ? [] : [tip];
    repo.commitSeq += 1;
    const timestamp = EPOCH_SEC + repo.commitSeq;
    const identity = `${this.viewer()} <${this.viewer()}@example.invalid>`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      author: identity,
      committer: identity,
      timestamp,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The file map at a branch tip (empty when the branch is unborn). */
  branchFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return new Map();
    const object = repo.objects.get(tip);
    if (object === undefined || object.type !== 'commit') return new Map();
    return treeFileMap(parseCommit(object.data).tree, (oid) => repo.objects.get(oid));
  }

  /** Commits reachable from a ref, newest first (depth-first from the tip). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const visit = (oid: string): void => {
      if (seen.has(oid)) return;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return;
      seen.add(oid);
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) visit(parent);
    };
    visit(tip);
    return order;
  }

  /** The merge-base of two commits: the common ancestor closest to both tips. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const generationsA = commitGenerations(a, (oid) => repo.objects.get(oid));
    if (generationsA.size === 0) return null;
    const queue: Array<{ oid: string; depth: number }> = [{ oid: b, depth: 1 }];
    const seen = new Set<string>();
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if (generationsA.has(oid)) {
        const total = (generationsA.get(oid) as number) + depth;
        if (total < bestDepth) {
          bestDepth = total;
          best = oid;
        }
      }
      for (const parent of parseCommit(object.data).parents) {
        if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    return best;
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const generations = commitGenerations(descendant, (oid) => repo.objects.get(oid));
    return generations.has(ancestor);
  }
}

/** Base64url of a short string, for opaque GraphQL global ids. */
export function encodeGlobalId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** Decode an opaque GraphQL global id, or null when it is not one. */
export function decodeGlobalId(id: string): string | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    return text.includes(':') ? text : null;
  } catch {
    return null;
  }
}

/** Count the lines of a text blob (a trailing newline does not start a new line). */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}
