// Git smart HTTP: info/refs (protocol v0 and v2), ls-refs, fetch (v2 and v0) and
// receive-pack (v0), over the shared store. Packs are written without deltas; pushed
// packs are read with ofs-delta and ref-delta resolution.
//
// The wire shapes here follow the git smart-HTTP protocol as the suite's client speaks
// it: pkt-line framing, capability advertisement, sideband-64k framing for packfiles
// and push reports, and report-status for pushes.

import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  writePack,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

/** One pkt-line: a 4-hex-digit length (header included) plus the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error('pkt-line payload is too large');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

/** Parse pkt-lines from the start of `buf`; returns the packets and bytes consumed.
 *  With `stopAtFlush`, parsing stops right after the first flush packet: a receive-pack
 *  body carries raw pack bytes after the flush, which are not pkt-lines. */
export function parsePktLines(buf: Buffer, stopAtFlush = false): { packets: Packet[]; consumed: number } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('malformed pkt-line header');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520 || offset + length > buf.length) {
      throw new Error('malformed pkt-line length');
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, consumed: offset };
}

function pktText(packet: Packet): string {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : '';
}

// ---------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json; charset=utf-8', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

// ---------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The refs of a repository, sorted, with peeled targets for annotated tags. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (isOid(target)) line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** The v0 advertisement for a service, with the `# service=` preamble. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = refLines(repo);
  const head = headOid(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The protocol v2 advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = ['version 2\n', 'agent=forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

export function handleInfoRefs(
  store: Store,
  owner: string,
  repoName: string,
  service: string,
  gitProtocolV2: boolean,
): GitResponse {
  const repo = store.lookupRepo(owner, repoName);
  if (repo === undefined) return notFound();
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
  }
  if (service !== 'git-upload-pack') return notFound();
  if (gitProtocolV2) return ok('application/x-git-upload-pack-advertisement', v2Advertisement());
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export function handleLsRefs(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.lookupRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let packets: Packet[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return badRequest('malformed pkt-line');
  }
  const lines = packets.filter((packet) => packet.kind === 'data').map(pktText);
  if (lines[0] !== 'command=ls-refs\n') return badRequest('expected command=ls-refs');
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines.slice(1)) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const refs = refLines(repo);
  const out: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && prefixes.length === 0) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (symrefs && keep('HEAD')) {
      out.push(pktLine(`${headOid(repo)} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Compute the objects a fetch sends, plus its shallow-info lines. */
/** True when `ancestor` is reachable from `tip` (or equals it), walking parents only
 *  until it is found. A full generation map per push would rescan the whole history
 *  on every push of a long linear branch; this stops after one step in that case. */
function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return false;
}

/** Commit generations from `tip`, but never expanding past `maxDepth` (tip = 1). The
 *  shallow-info computation only needs commits up to the fetch depth, not the whole
 *  history behind a 200-commit repo. */
function generationsUpTo(
  tip: string,
  lookup: (oid: string) => GitObject | undefined,
  maxDepth: number,
): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [{ oid: tip, depth: 1 }];
  while (queue.length > 0) {
    const { oid, depth } = queue.shift() as { oid: string; depth: number };
    const existing = generations.get(oid);
    if (existing !== undefined && existing <= depth) continue;
    generations.set(oid, depth);
    if (depth >= maxDepth) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return generations;
}

function computeFetch(
  repo: Repo,
  request: FetchRequest,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Haves named in `shallow` are shallow boundaries: the client holds the commit (and
  // its tree) but not its parents, so the held set must not traverse past them.
  const haveSet = collectReachable(request.haves, lookup, { stopAt: new Set(request.shallow) });
  let wanted: Set<string>;
  if (request.depth !== null) {
    wanted = collectReachable(request.wants, lookup, { maxCommitDepth: request.depth });
  } else {
    wanted = collectReachable(request.wants, lookup);
  }
  const send = new Set<string>();
  for (const oid of wanted) if (!haveSet.has(oid)) send.add(oid);
  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  // Shallow-info: commits sent at the depth limit whose parent is not sent (and not held).
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (request.depth !== null) {
    const generations = new Map<string, number>();
    for (const want of request.wants) {
      for (const [oid, depth] of generationsUpTo(want, lookup, request.depth)) {
        const existing = generations.get(oid);
        if (existing === undefined || depth < existing) generations.set(oid, depth);
      }
    }
    for (const oid of send) {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      if ((generations.get(oid) ?? 0) !== request.depth) continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => repo.objects.has(parent) && !send.has(parent) && !haveSet.has(parent))) {
        shallow.push(oid);
      }
    }
    for (const boundary of request.shallow) {
      const object = repo.objects.get(boundary);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.every((parent) => send.has(parent) || haveSet.has(parent) || !repo.objects.has(parent))) {
        if (send.has(boundary) || haveSet.has(boundary)) unshallow.push(boundary);
      }
    }
  }
  return { objects, shallow, unshallow };
}

/** Split a pack into sideband-64k packets (band 1). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 60000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, isV2: boolean): GitResponse {
  const repo = store.lookupRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let packets: Packet[];
  try {
    packets = parsePktLines(body).packets;
  } catch {
    return badRequest('malformed pkt-line');
  }
  const lines = packets.filter((packet) => packet.kind === 'data').map(pktText);
  const command = lines[0]?.replace(/\n$/, '') ?? '';
  if (command === 'command=ls-refs') return handleLsRefs(store, owner, repoName, body);
  if (command !== 'command=fetch' && !lines[0]?.startsWith('want ')) {
    return badRequest('unsupported upload-pack command');
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  let seenFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = pktText(packet).replace(/\n$/, '');
    if (text === 'command=fetch' || text === 'delim' || text === 'done' || text === 'thin-pack' || text === 'no-progress' || text === 'ofs-delta') continue;
    if (text.startsWith('want ')) request.wants.push(text.slice(5).trim().split(' ')[0] as string);
    else if (text.startsWith('have ')) request.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) request.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) request.depth = depth;
    }
  }
  void seenFlush;
  request.wants = [...new Set(request.wants)].filter(isOid);
  request.haves = [...new Set(request.haves)].filter(isOid);
  const { objects, shallow, unshallow } = computeFetch(repo, request);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  if (isV2) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    parts.push(pktLine('NAK\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPack(pack));
    parts.push(pktFlush());
  }
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.lookupRepo(owner, repoName);
  if (repo === undefined) return notFound();
  let parsed: { packets: Packet[]; consumed: number };
  try {
    parsed = parsePktLines(body, true);
  } catch {
    return badRequest('malformed pkt-line');
  }
  const commands: PushCommand[] = [];
  let unpackError: string | null = null;
  for (const packet of parsed.packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let text = pktText(packet).replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length !== 3 || !isOid(parts[0] as string) || !isOid(parts[1] as string)) {
      unpackError = 'malformed command';
      break;
    }
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  let unpacked: Map<string, GitObject> | null = null;
  if (unpackError === null) {
    const packBytes = body.subarray(parsed.consumed);
    if (packBytes.length > 0) {
      try {
        unpacked = readPack(packBytes).objects;
        for (const [oid, object] of unpacked) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (err) {
        unpackError = err instanceof Error ? err.message : 'unpack failed';
      }
    }
  }
  void unpacked;
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      let failure: string | null = null;
      if (command.newOid === ZERO_OID) {
        if (current === undefined) failure = 'ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) failure = 'old value mismatch';
      } else {
        const object = repo.objects.get(command.newOid);
        if (object === undefined) {
          failure = 'object not found';
        } else if (command.oldOid === ZERO_OID) {
          if (current !== undefined) failure = 'already exists';
          else if (command.ref.startsWith('refs/heads/') && object.type !== 'commit') failure = 'not a commit';
        } else {
          if (current === undefined) failure = 'ref does not exist';
          else if (command.oldOid !== current) failure = 'old value mismatch';
          else if (command.ref.startsWith('refs/heads/') && object.type === 'commit') {
            if (!isAncestor(repo, current, command.newOid)) failure = 'non-fast-forward';
          }
        }
      }
      if (failure !== null) {
        reportLines.push(`ng ${command.ref} ${failure}\n`);
      } else {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
    }
  }
  // The report-status stream, pkt-lined, inside sideband band 1.
  const reportBytes = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportBytes])), pktFlush()];
  return ok('application/x-git-receive-pack-result', Buffer.concat(parts));
}

/** The SHA-1 of an object the store already holds (used by REST commit creation). */
export function objectId(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  return hashObject(type, data);
}

/** The entries of a tree object, for the REST layer. */
export function treeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  return parseTree(data);
}
