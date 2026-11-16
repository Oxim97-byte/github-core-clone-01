// The forge's store: repositories, git objects, refs, issues, pull requests,
// labels and comments, held in memory and snapshotted to disk in our own
// format. Nothing in the state reads a clock: commit timestamps are a fixed
// base plus a per-repository sequence, so two runs on the same inputs build
// byte-identical state.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTree,
  type GitObject,
  type GitObjectType,
} from './gitproto.ts';
import { viewerIdentity } from './scenario.ts';

export const FIXED_EPOCH = 1_700_000_000;
export const FIXED_ISO = '2025-01-01T00:00:00.000Z';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  url: string;
  default: boolean;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; label: string };
  base: { ref: string; sha: string; label: string };
  merged: boolean;
  mergeable: boolean | null;
  merge_commit_sha: string | null;
  merged_at: string | null;
  closed_at: string | null;
  seq: number;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  numberSeq: number;
  labelSeq: number;
  commitSeq: number;
  packCache: Map<string, Buffer>;
}

export interface StoreState {
  repos: Map<string, Repo>;
  repoIdSeq: number;
  issueIdSeq: number;
  commentIdSeq: number;
  labelIdSeq: number;
  requestSeq: number;
}

export function createStore(): StoreState {
  return { repos: new Map(), repoIdSeq: 1, issueIdSeq: 1, commentIdSeq: 1, labelIdSeq: 1, requestSeq: 0 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(store: StoreState, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

export function createRepoRecord(
  store: StoreState,
  owner: string,
  name: string,
  options: { description?: string; private?: boolean; defaultBranch?: string },
): Repo {
  const repo: Repo = {
    id: store.repoIdSeq++,
    name,
    owner,
    description: options.description ?? '',
    private: options.private ?? false,
    defaultBranch: options.defaultBranch ?? 'main',
    seq: store.repos.size,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    numberSeq: 0,
    labelSeq: 0,
    commitSeq: 0,
    packCache: new Map(),
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}

export function deleteRepo(store: StoreState, owner: string, name: string): boolean {
  return store.repos.delete(repoKey(owner, name));
}

export function viewerRepos(store: StoreState, owner: string): Repo[] {
  const out: Repo[] = [];
  for (const repo of store.repos.values()) if (repo.owner === owner) out.push(repo);
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

export function invalidatePackCache(repo: Repo): void {
  repo.packCache.clear();
}

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The identity our own commits carry. */
export function forgeIdentity(): string {
  const viewer = viewerIdentity();
  return `${viewer.name} <${viewer.email}>`;
}

/**
 * Build nested tree objects from a flat path -> {oid, mode} map, storing every
 * new tree object in the repo. Returns the root tree oid.
 */
export function buildTreeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Commit `files` on `branch` (creating the branch when needed). Returns the commit oid. */
export function commitFiles(
  repo: Repo,
  branch: string,
  files: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const treeOid = buildTreeFromFiles(repo, files);
  const timestamp = FIXED_EPOCH + repo.commitSeq++;
  const data = buildCommit({
    tree: treeOid,
    parents: parent !== undefined && isObjectId(parent) ? [parent] : [],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: forgeIdentity(),
    timestamp,
  });
  const oid = putObject(repo, 'commit', data);
  repo.refs.set(ref, oid);
  invalidatePackCache(repo);
  return oid;
}

/** The flat file map of a branch tip (empty when the branch does not exist). */
export function branchFiles(repo: Repo, branch: string): Map<string, { oid: string; mode: string }> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return new Map();
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return new Map();
  return flattenTree((oid) => repo.objects.get(oid), parseCommit(object.data).tree);
}

/** Read one file's bytes from a branch tip, or null. */
export function branchFileBytes(repo: Repo, branch: string, path: string): Buffer | null {
  const files = branchFiles(repo, branch);
  const entry = files.get(path);
  if (!entry) return null;
  const object = repo.objects.get(entry.oid);
  return object && object.type === 'blob' ? object.data : null;
}

/** List the commits reachable from `tip`, newest first (DFS in parent order). */
export function listCommits(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack: string[] = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** Diff two flat file maps. */
export function diffFiles(
  oldFiles: Map<string, { oid: string; mode: string }>,
  newFiles: Map<string, { oid: string; mode: string }>,
): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
  const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry && !newEntry) out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    else if (!oldEntry && newEntry) out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Count lines in a blob (a trailing newline does not add an empty line). */
export function lineCount(data: Buffer): number {
  if (data.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] === 0x0a) count += 1;
  if (data[data.length - 1] !== 0x0a) count += 1;
  return count;
}

/** A tree's direct entries (for directory listings). */
export function treeEntries(repo: Repo, treeOid: string): { mode: string; name: string; oid: string }[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data);
}

// ---------------------------------------------------------------------------------------------
// persistence: one JSON snapshot, written atomically, debounced
// ---------------------------------------------------------------------------------------------

const STATE_FILE = process.env.FORGE_STATE_FILE ?? '/tmp/forge-state.json';

interface SnapshotRepo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  objects: [string, string, string][];
  refs: [string, string][];
  issues: unknown[];
  pulls: unknown[];
  labels: unknown[];
  numberSeq: number;
  labelSeq: number;
  commitSeq: number;
}

function snapshotOf(store: StoreState): string {
  const repos: SnapshotRepo[] = [];
  for (const repo of store.repos.values()) {
    repos.push({
      id: repo.id,
      name: repo.name,
      owner: repo.owner,
      description: repo.description,
      private: repo.private,
      defaultBranch: repo.defaultBranch,
      seq: repo.seq,
      objects: [...repo.objects.entries()].map(([oid, object]) => [oid, object.type, object.data.toString('base64')] as [string, string, string]),
      refs: [...repo.refs.entries()],
      issues: [...repo.issues.values()].map((issue) => ({
        ...issue,
        labels: issue.labels,
        comments: issue.comments,
      })),
      pulls: [...repo.pulls.values()],
      labels: [...repo.labels.values()],
      numberSeq: repo.numberSeq,
      labelSeq: repo.labelSeq,
      commitSeq: repo.commitSeq,
    });
  }
  return JSON.stringify({
    version: 1,
    repoIdSeq: store.repoIdSeq,
    issueIdSeq: store.issueIdSeq,
    commentIdSeq: store.commentIdSeq,
    labelIdSeq: store.labelIdSeq,
    repos,
  });
}

export function saveSnapshot(store: StoreState): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    writeFileSync(tmp, snapshotOf(store));
    renameSync(tmp, STATE_FILE);
  } catch {
    // Persistence is best-effort; the in-memory store is authoritative.
  }
}

export function loadSnapshot(): StoreState | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
      version?: number;
      repoIdSeq?: number;
      issueIdSeq?: number;
      commentIdSeq?: number;
      labelIdSeq?: number;
      repos?: SnapshotRepo[];
    };
    if (parsed.version !== 1 || !Array.isArray(parsed.repos)) return null;
    const store = createStore();
    store.repoIdSeq = parsed.repoIdSeq ?? 1;
    store.issueIdSeq = parsed.issueIdSeq ?? 1;
    store.commentIdSeq = parsed.commentIdSeq ?? 1;
    store.labelIdSeq = parsed.labelIdSeq ?? 1;
    for (const snap of parsed.repos) {
      const repo: Repo = {
        id: snap.id,
        name: snap.name,
        owner: snap.owner,
        description: snap.description,
        private: snap.private,
        defaultBranch: snap.defaultBranch,
        seq: snap.seq,
        objects: new Map(),
        refs: new Map(snap.refs),
        issues: new Map(),
        pulls: new Map(),
        labels: new Map(),
        numberSeq: snap.numberSeq,
        labelSeq: snap.labelSeq,
        commitSeq: snap.commitSeq,
        packCache: new Map(),
      };
      for (const [oid, type, b64] of snap.objects) {
        repo.objects.set(oid, { type: type as GitObjectType, data: Buffer.from(b64, 'base64') });
      }
      for (const issue of snap.issues as Issue[]) repo.issues.set(issue.number, issue);
      for (const pull of snap.pulls as Pull[]) repo.pulls.set(pull.number, pull);
      for (const label of snap.labels as Label[]) repo.labels.set(label.name, label);
      store.repos.set(repoKey(repo.owner, repo.name), repo);
    }
    return store;
  } catch {
    return null;
  }
}

/** Start the debounced snapshot writer (every 5 s while dirty). Returns a stop function. */
export function startSnapshotLoop(store: StoreState, isDirty: () => boolean, clearDirty: () => void): () => void {
  const timer = setInterval(() => {
    if (isDirty()) {
      clearDirty();
      saveSnapshot(store);
    }
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
