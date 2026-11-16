// git smart HTTP: info/refs advertisements (v0 and v2), protocol v2 ls-refs
// and fetch, protocol v0 fetch, and receive-pack pushes with report-status.
// Packfiles are plain objects (no deltas); packs for identical fetches are
// cached per repository and invalidated on any mutation.

import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  isAncestor,
  isObjectId,
  parseTag,
  pktFlush,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
  type GitObject,
} from './gitproto.ts';
import { invalidatePackCache, type Repo } from './store.ts';

export interface GitResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = 'symref=HEAD:refs/heads/main multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main';

function result(status: number, contentType: string, body: Buffer): GitResult {
  return { status, contentType, body };
}

function notFound(): GitResult {
  return result(404, 'text/plain; charset=utf-8', Buffer.from('Not Found\n', 'utf8'));
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** The repository's refs as advertisement lines, HEAD first, peeled tags after their tag. */
function refLines(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const headTarget = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTarget !== undefined) lines.push({ oid: headTarget, name: 'HEAD' });
  for (const [name, oid] of refs) {
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/') && object?.type === 'tag') {
      peeled = parseTag(object.data).object;
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(repo: Repo | null, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: number): GitResult {
  if (repo === null) return notFound();
  if (service === 'git-upload-pack' && gitProtocol === 2) {
    const lines: (string | 'flush')[] = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow thin-pack ofs-delta\n',
      'object-format=sha1\n',
      'flush',
    ];
    return result(200, 'application/x-git-upload-pack-advertisement', encodePktLines(lines));
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const refs = refLines(repo);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\u0000${caps}` : '';
      parts.push(encodePktLine(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return result(200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** POST git-upload-pack with a v2 ls-refs command. */
function handleLsRefs(repo: Repo, args: LsRefsArgs): GitResult {
  const refs = refLines(repo);
  const out: string[] = [];
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (args.unborn && keep('HEAD')) {
      out.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.name === 'HEAD') {
        if (args.symrefs) out.push(`${ref.oid} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      out.push(`${line}\n`);
    }
  }
  const parts = out.map((line) => encodePktLine(line));
  parts.push(pktFlush());
  return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

/**
 * The objects a fetch must send: reachable from the wants within `depth`,
 * minus what the client already holds (full closure of plain haves; a
 * depth-1 closure of haves that are themselves shallow boundaries).
 */
function fetchObjects(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const lookup = (oid: string) => repo.objects.get(oid);
  const shallowSet = new Set(args.shallow);
  const haveClosure = new Set<string>();
  for (const have of args.haves) {
    const depth = shallowSet.has(have) ? 1 : undefined;
    for (const oid of collectReachable([have], lookup, { depth, allowMissing: true })) haveClosure.add(oid);
  }
  const wanted = collectReachable(args.wants, lookup, { depth: args.depth ?? undefined, allowMissing: true });
  const send: GitObject[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveClosure.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) send.push(object);
  }
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== null) {
    // The new shallow boundary: the wants' commits at the depth edge.
    const edge = collectReachable(args.wants, lookup, { depth: args.depth, allowMissing: true });
    const inner = args.depth > 1 ? collectReachable(args.wants, lookup, { depth: args.depth - 1, allowMissing: true }) : new Set<string>();
    for (const oid of [...edge].sort()) {
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      if (inner.has(oid)) continue;
      if (!haveClosure.has(oid)) shallow.push(oid);
    }
    for (const boundary of args.shallow) {
      if (!shallow.includes(boundary) && wanted.has(boundary)) unshallow.push(boundary);
    }
  }
  return { objects: send, shallow, unshallow };
}

/** Chunk a pack into sideband band-1 pkt-lines (each at most 65515 data bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += 65515) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(encodePktLine(Buffer.from([1])));
  return parts;
}

function packCacheKey(args: FetchArgs): string {
  return JSON.stringify({ w: [...args.wants].sort(), h: [...args.haves].sort(), s: [...args.shallow].sort(), d: args.depth });
}

/** POST git-upload-pack with a v2 fetch command. */
function handleFetchV2(repo: Repo, args: FetchArgs): GitResult {
  const key = packCacheKey(args);
  let pack = repo.packCache.get(key);
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (pack === undefined) {
    const computed = fetchObjects(repo, args);
    pack = writePack(computed.objects);
    shallow = computed.shallow;
    unshallow = computed.unshallow;
    repo.packCache.set(key, pack);
  } else if (args.depth !== null) {
    // The pack is cached, but the shallow-info lines still need computing.
    const computed = fetchObjects(repo, args);
    shallow = computed.shallow;
    unshallow = computed.unshallow;
  }
  const parts: Buffer[] = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), pktFlush()];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST git-upload-pack with a v0 fetch (want/have/done). */
function handleFetchV0(repo: Repo, args: FetchArgs): GitResult {
  const key = packCacheKey(args);
  let pack = repo.packCache.get(key);
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (pack === undefined) {
    const computed = fetchObjects(repo, args);
    pack = writePack(computed.objects);
    shallow = computed.shallow;
    unshallow = computed.unshallow;
    repo.packCache.set(key, pack);
  } else if (args.depth !== null) {
    const computed = fetchObjects(repo, args);
    shallow = computed.shallow;
    unshallow = computed.unshallow;
  }
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush());
  return result(200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(repo: Repo | null, body: Buffer, gitProtocol: number): GitResult {
  if (repo === null) return notFound();
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  if (gitProtocol === 2) {
    // v2: command line(s), delim, arguments, flush. The delim packet is a
    // control packet, not a data line, so split on it while decoding.
    const head: string[] = [];
    const args: string[] = [];
    let afterDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        afterDelim = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      (afterDelim ? args : head).push(packet.payload.toString('utf8'));
    }
    const command = head.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const rawArg of args) {
        const arg = rawArg.replace(/\n$/, '');
        if (arg === 'peel') lsArgs.peel = true;
        else if (arg === 'symrefs') lsArgs.symrefs = true;
        else if (arg === 'unborn') lsArgs.unborn = true;
        else if (arg.startsWith('ref-prefix ')) lsArgs.prefixes.push(arg.slice('ref-prefix '.length));
      }
      return handleLsRefs(repo, lsArgs);
    }
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
      for (const arg of args) {
        const line = arg.replace(/\n$/, '');
        if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(line.slice(7).trim(), 10);
        else if (line === 'done') fetchArgs.done = true;
      }
      return handleFetchV2(repo, fetchArgs);
    }
    return result(400, 'text/plain; charset=utf-8', Buffer.from(`unknown command ${command}\n`, 'utf8'));
  }
  // v0: want/have/shallow/deepen/done lines, flush-separated sections.
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') fetchArgs.done = true;
  }
  return handleFetchV0(repo, fetchArgs);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(repo: Repo | null, body: Buffer): GitResult {
  if (repo === null) return notFound();
  const { packets, rawRest } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\u0000');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const received: GitObject[] = [];
  if (rawRest.length > 0) {
    try {
      if (!verifyPackChecksum(rawRest)) throw new Error('pack trailer checksum mismatch');
      const { objects } = readPack(rawRest, (oid) => repo.objects.get(oid));
      received.push(...objects);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const lookup = (oid: string) => repo.objects.get(oid);
  const report: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  if (unpackOk) {
    for (const object of received) {
      const oid = hashObject(object.type, object.data);
      if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    }
    let moved = false;
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let reason: string | null = null;
      if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
        reason = 'invalid object id';
      } else if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === ZERO_OID) reason = 'non-fast-forward';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
      } else {
        if (command.oldOid === ZERO_OID && current !== ZERO_OID) reason = 'non-fast-forward';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) reason = 'non-fast-forward';
        else if (!repo.objects.has(command.newOid)) reason = 'non-fast-forward';
        else if (command.oldOid !== ZERO_OID && !isAncestor(lookup, command.oldOid, command.newOid)) reason = 'non-fast-forward';
      }
      if (reason !== null) {
        report.push(`ng ${command.ref} ${reason}\n`);
        continue;
      }
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      moved = true;
      report.push(`ok ${command.ref}\n`);
    }
    if (moved) invalidatePackCache(repo);
  } else {
    for (const command of commands) report.push(`ng ${command.ref} unpack failed\n`);
  }
  const reportBytes = encodePktLines([...report, 'flush']);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < reportBytes.length; offset += 65515) {
    const chunk = reportBytes.subarray(offset, Math.min(reportBytes.length, offset + 65515));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return result(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
