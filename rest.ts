// GitHub REST v3 surface: repositories, branches, commits, contents, issues,
// comments, labels and pull requests. Every reply is JSON with an
// X-GitHub-Request-Id; errors are JSON {message}. Ownership: a repository
// belongs to the token's login, so any other owner is 404, never 403.

import {
  branchFileBytes,
  branchFiles,
  buildTreeFromFiles,
  commitFiles,
  createRepoRecord,
  deleteRepo,
  forgeIdentity,
  diffFiles,
  FIXED_ISO,
  getRepo,
  invalidatePackCache,
  lineCount,
  listCommits,
  putObject,
  treeEntries,
  viewerRepos,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type StoreState,
} from './store.ts';
import { commentGlobalId, issueGlobalId, pullGlobalId, repoGlobalId } from './ids.ts';
import {
  buildCommit,
  flattenTree,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
} from './gitproto.ts';
import type { ViewerIdentity } from './scenario.ts';

export interface RestContext {
  store: StoreState;
  viewer: ViewerIdentity;
  requestId: string;
  baseUrl: string;
}

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestResult {
  return { status, body, headers };
}

function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

export function userJson(viewer: ViewerIdentity): Record<string, unknown> {
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: `U_${viewer.id}`,
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `https://github.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    company: null,
    blog: '',
    location: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function repoUrl(ctx: RestContext, repo: Repo): string {
  return `/api/v3/repos/${repo.owner}/${repo.name}`;
}

export function repoJson(ctx: RestContext, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ctx.viewer.id, node_id: `U_${ctx.viewer.id}`, avatar_url: '', type: 'User', site_admin: false },
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(ctx, repo),
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues + openPulls,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: '',
    name: label.name,
    color: label.color,
    default: label.default,
    description: label.description,
  };
}

export function issueJson(ctx: RestContext, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.id, issue.number),
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    repository_url: repoUrl(ctx, repo),
    labels_url: `${repoUrl(ctx, repo)}/issues/${issue.number}/labels`,
    comments_url: `${repoUrl(ctx, repo)}/issues/${issue.number}/comments`,
    events_url: `${repoUrl(ctx, repo)}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: issue.user, id: ctx.viewer.id, type: 'User', avatar_url: '' },
    labels: issue.labels.map(labelJson),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    author_association: 'OWNER',
    active_lock_reason: null,
  };
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: commentGlobalId(comment.id),
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: comment.user, id: ctx.viewer.id, type: 'User', avatar_url: '' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    author_association: 'OWNER',
  };
}

function headBaseJson(ctx: RestContext, repo: Repo, side: { ref: string; sha: string; label: string }): Record<string, unknown> {
  return {
    label: side.label,
    ref: side.ref,
    sha: side.sha,
    user: { login: repo.owner, id: ctx.viewer.id, type: 'User', avatar_url: '' },
    repo: repoJson(ctx, repo),
  };
}

export function pullJson(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.id, pull.number),
    url: `${repoUrl(ctx, repo)}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${repoUrl(ctx, repo)}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: pull.user, id: ctx.viewer.id, type: 'User', avatar_url: '' },
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.closed_at,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    merged: pull.merged,
    mergeable: pull.mergeable,
    mergeable_state: pull.mergeable === null ? 'unknown' : pull.mergeable ? 'clean' : 'dirty',
    merged_by: null,
    head: headBaseJson(ctx, repo, pull.head),
    base: headBaseJson(ctx, repo, pull.base),
  };
}

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10) || 30;
  const perPage = Math.min(100, Math.max(1, perPageRaw));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, basePath: string): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URLSearchParams(query);
    next.set('page', String(page + 1));
    next.set('per_page', String(perPage));
    link = `<${basePath}?${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function linkHeader(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

/** Resolve a ref name or oid to a commit oid on this repo, or null. */
function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct !== undefined) return direct;
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function tipTree(repo: Repo, tip: string): string | null {
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Compute whether a pull request merges cleanly (three-way, no content merge). */
export function pullMergeable(repo: Repo, pull: Pull): boolean {
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  if (!repo.objects.has(headTip) || !repo.objects.has(baseTip)) return false;
  const lookup = (oid: string) => repo.objects.get(oid);
  const base = mergeBase(lookup, headTip, baseTip);
  if (base === null) return true;
  const baseTree = tipTree(repo, base);
  const headTree = tipTree(repo, headTip);
  const baseTipTree = tipTree(repo, baseTip);
  if (baseTree === null || headTree === null || baseTipTree === null) return false;
  const baseFiles = flattenTree(lookup, baseTree);
  const headFiles = flattenTree(lookup, headTree);
  const baseTipFiles = flattenTree(lookup, baseTipTree);
  const headChanges = diffFiles(baseFiles, headFiles);
  const baseChanges = diffFiles(baseFiles, baseTipFiles);
  const baseChanged = new Map(baseChanges.map((c) => [c.path, c.newOid]));
  for (const change of headChanges) {
    if (baseChanged.has(change.path) && baseChanged.get(change.path) !== change.newOid) return false;
  }
  return true;
}

/** A repository the caller may read (owner must be the viewer). */
function readableRepo(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.viewer.login) return null;
  return getRepo(ctx.store, owner, name) ?? null;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The main REST dispatcher. `segments` are the path parts after /api/v3. */
export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
): RestResult {
  const seg = segments.map(decodePathSegment);

  // API root and meta.
  if (seg.length === 0) {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return err(404, 'Not Found');
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') return ok(200, userJson(ctx.viewer));
    return err(404, 'Not Found');
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (seg.length !== 2) return err(404, 'Not Found');
    if (method === 'GET') {
      const repos = viewerRepos(ctx.store, ctx.viewer.login);
      const { page, link } = paginate(repos, query, `${ctx.baseUrl}/api/v3/user/repos`);
      return ok(200, page.map((repo) => repoJson(ctx, repo)), linkHeader(link));
    }
    if (method === 'POST') {
      if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
      const input = body as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (name === '') return err(422, 'Validation Failed: name is required');
      if (getRepo(ctx.store, ctx.viewer.login, name) !== undefined) return err(422, 'Validation Failed: name already exists on this account');
      const repo = createRepoRecord(ctx.store, ctx.viewer.login, name, {
        description: typeof input.description === 'string' ? input.description : '',
        private: input.private === true,
        defaultBranch: typeof input.default_branch === 'string' && input.default_branch !== '' ? input.default_branch : 'main',
      });
      return ok(201, repoJson(ctx, repo));
    }
    return err(404, 'Not Found');
  }

  if (seg[0] !== 'repos' || seg.length < 3) return err(404, 'Not Found');
  const owner = seg[1] as string;
  const name = seg[2] as string;
  const repo = readableRepo(ctx, owner, name);
  if (repo === null) return err(404, 'Not Found');
  const rest = seg.slice(3);

  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') return ok(200, repoJson(ctx, repo));
    if (method === 'PATCH') {
      if (typeof body === 'object' && body !== null) {
        const input = body as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      }
      return ok(200, repoJson(ctx, repo));
    }
    if (method === 'DELETE') {
      deleteRepo(ctx.store, owner, name);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({
          name: branch,
          commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string, url: '' },
          protected: false,
        }));
      return ok(200, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha, url: '' }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // commits
  if (rest[0] === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const tip = resolveRef(repo, query.get('sha') ?? undefined);
      if (tip === null) return ok(200, []);
      const shas = listCommits(repo, tip);
      const commits = shas.map((sha) => commitJson(ctx, repo, sha));
      const { page, link } = paginate(commits, query, `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/commits`);
      return ok(200, page, linkHeader(link));
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') return err(404, 'Not Found');
      return ok(200, commitJson(ctx, repo, sha));
    }
    return err(404, 'Not Found');
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
      const input = body as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        return err(422, 'Validation Failed: ref or sha is invalid');
      }
      if (repo.refs.has(ref)) return err(422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      invalidatePackCache(repo);
      return ok(201, { ref, object: { sha, type: 'commit', url: '' }, url: '' });
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref, object: { sha, type: 'commit', url: '' }, url: '' });
    }
    return err(404, 'Not Found');
  }

  // contents
  if (rest[0] === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path, query.get('ref') ?? undefined);
    if (method === 'PUT') return putContents(ctx, repo, path, body);
    if (method === 'DELETE') return deleteContents(ctx, repo, path, body);
    return err(404, 'Not Found');
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return ok(200, [...repo.labels.values()].map(labelJson));
    }
    if (method === 'POST' && rest.length === 1) {
      if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
      const input = body as Record<string, unknown>;
      const labelName = typeof input.name === 'string' ? input.name.trim() : '';
      if (labelName === '') return err(422, 'Validation Failed: name is required');
      const existing = repo.labels.get(labelName);
      if (existing) return ok(201, labelJson(existing));
      const label: Label = {
        id: ctx.store.labelIdSeq++,
        name: labelName,
        color: typeof input.color === 'string' && input.color !== '' ? input.color.replace(/^#/, '') : 'ededed',
        description: typeof input.description === 'string' ? input.description : '',
        url: '',
        default: false,
      };
      repo.labels.set(labelName, label);
      return ok(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
        issues.sort((a, b) => (sort === 'created' ? a.seq - b.seq : a.seq - b.seq));
        if (direction === 'desc') issues.reverse();
        const { page, link } = paginate(issues, query, `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/issues`);
        return ok(200, page.map((issue) => issueJson(ctx, repo, issue)), linkHeader(link));
      }
      if (method === 'POST') {
        if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
        const input = body as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        if (title === '') return err(422, 'Validation Failed: title is required');
        const labelNames: string[] = [];
        if (Array.isArray(input.labels)) {
          for (const entry of input.labels) {
            const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined;
            if (typeof labelName === 'string') labelNames.push(labelName);
          }
        }
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (!label) return err(422, `Validation Failed: label "${labelName}" does not exist`);
          labels.push(label);
        }
        const number = ++repo.numberSeq;
        const issue: Issue = {
          id: ctx.store.issueIdSeq++,
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels,
          comments: [],
          seq: number,
          user: ctx.viewer.login,
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
          closed_at: null,
        };
        repo.issues.set(number, issue);
        return ok(201, issueJson(ctx, repo, issue));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isSafeInteger(number)) return err(404, 'Not Found');
    const issue = repo.issues.get(number);
    if (rest.length === 2) {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, issueJson(ctx, repo, issue));
      if (method === 'PATCH') {
        if (typeof body === 'object' && body !== null) {
          const input = body as Record<string, unknown>;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'open' || input.state === 'closed') {
            issue.state = input.state;
            issue.closed_at = input.state === 'closed' ? FIXED_ISO : null;
          }
          if (Array.isArray(input.labels)) {
            const labels: Label[] = [];
            for (const entry of input.labels) {
              const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).name : undefined;
              const label = typeof labelName === 'string' ? repo.labels.get(labelName) : undefined;
              if (label) labels.push(label);
            }
            issue.labels = labels;
          }
        }
        return ok(200, issueJson(ctx, repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'comments') {
      if (!issue) return err(404, 'Not Found');
      if (method === 'GET') {
        const { page, link } = paginate(issue.comments, query, `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/issues/${number}/comments`);
        return ok(200, page.map((comment) => commentJson(ctx, repo, issue, comment)), linkHeader(link));
      }
      if (method === 'POST') {
        if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
        const input = body as Record<string, unknown>;
        const text = typeof input.body === 'string' ? input.body : '';
        if (text === '') return err(422, 'Validation Failed: body is required');
        const comment: Comment = {
          id: ctx.store.commentIdSeq++,
          body: text,
          user: ctx.viewer.login,
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        };
        issue.comments.push(comment);
        return ok(201, commentJson(ctx, repo, issue, comment));
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') pulls = pulls.filter((p) => p.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(pulls, query, `${ctx.baseUrl}/api/v3/repos/${owner}/${name}/pulls`);
        return ok(200, page.map((pull) => pullJson(ctx, repo, pull)), linkHeader(link));
      }
      if (method === 'POST') {
        if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
        const input = body as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
        if (title === '' || head === '') return err(422, 'Validation Failed: title and head are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) return err(422, 'Validation Failed: head or base branch does not exist');
        const number = ++repo.numberSeq;
        const pull: Pull = {
          id: ctx.store.issueIdSeq++,
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          head: { ref: head, sha: headSha, label: `${repo.owner}:${head}` },
          base: { ref: base, sha: baseSha, label: `${repo.owner}:${base}` },
          merged: false,
          mergeable: null,
          merge_commit_sha: null,
          merged_at: null,
          closed_at: null,
          seq: number,
          user: ctx.viewer.login,
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        };
        pull.mergeable = pullMergeable(repo, pull);
        repo.pulls.set(number, pull);
        return ok(201, pullJson(ctx, repo, pull));
      }
      return err(404, 'Not Found');
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isSafeInteger(number)) return err(404, 'Not Found');
    const pull = repo.pulls.get(number);
    if (rest.length === 2) {
      if (!pull) return err(404, 'Not Found');
      if (method === 'GET') {
        pull.mergeable = pullMergeable(repo, pull);
        return ok(200, pullJson(ctx, repo, pull));
      }
      if (method === 'PATCH') {
        if (typeof body === 'object' && body !== null) {
          const input = body as Record<string, unknown>;
          if (typeof input.title === 'string') pull.title = input.title;
          if (typeof input.body === 'string') pull.body = input.body;
          if (input.state === 'closed' && pull.state === 'open') {
            pull.state = 'closed';
            pull.closed_at = FIXED_ISO;
          }
        }
        return ok(200, pullJson(ctx, repo, pull));
      }
      return err(404, 'Not Found');
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pull) return err(404, 'Not Found');
      return ok(200, pullFiles(ctx, repo, pull));
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return err(404, 'Not Found');
      return mergePull(ctx, repo, pull);
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function commitJson(ctx: RestContext, repo: Repo, sha: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  const view = object ? parseCommit(object.data) : { tree: '', parents: [], author: '', committer: '', message: '' };
  const authorName = view.author.split('<')[0]?.trim() ?? '';
  const message = view.message.replace(/\n+$/, '');
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author: { name: authorName, email: ctx.viewer.email, date: FIXED_ISO },
      committer: { name: authorName, email: ctx.viewer.email, date: FIXED_ISO },
      message,
      tree: { sha: view.tree, url: '' },
      url: '',
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: '',
    html_url: '',
    comments_url: '',
    author: { login: ctx.viewer.login, id: ctx.viewer.id, type: 'User' },
    committer: { login: ctx.viewer.login, id: ctx.viewer.id, type: 'User' },
    parents: view.parents.map((parent) => ({ sha: parent, url: '', html_url: '' })),
  };
}

function getContents(ctx: RestContext, repo: Repo, path: string, ref: string | undefined): RestResult {
  const tip = resolveRef(repo, ref);
  if (tip === null) return err(404, 'Not Found');
  const treeOid = tipTree(repo, tip);
  if (treeOid === null) return err(404, 'Not Found');
  const lookup = (oid: string) => repo.objects.get(oid);
  if (path === '') {
    const entries = treeEntries(repo, treeOid)
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((entry) => contentEntry(ctx, repo, entry, ''));
    return ok(200, entries);
  }
  const segments = path.split('/');
  let currentTree = treeOid;
  let currentPath = '';
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const entries = treeEntries(repo, currentTree);
    const found = entries.find((entry) => entry.name === segment);
    if (!found) return err(404, 'Not Found');
    currentPath = currentPath === '' ? segment : `${currentPath}/${segment}`;
    if (index === segments.length - 1) {
      if (found.mode === '40000') {
        const children = treeEntries(repo, found.oid)
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map((entry) => contentEntry(ctx, repo, entry, currentPath));
        return ok(200, children);
      }
      const blob = repo.objects.get(found.oid);
      if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
      return ok(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: segment,
        path: currentPath,
        content: blob.data.toString('base64'),
        sha: found.oid,
        url: '',
        html_url: '',
        git_url: '',
        download_url: '',
      });
    }
    if (found.mode !== '40000') return err(404, 'Not Found');
    currentTree = found.oid;
  }
  return err(404, 'Not Found');
}

function contentEntry(
  ctx: RestContext,
  repo: Repo,
  entry: { mode: string; name: string; oid: string },
  dir: string,
): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const object = repo.objects.get(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : object?.data.length ?? 0,
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    sha: entry.oid,
    url: '',
    html_url: '',
    git_url: '',
    download_url: '',
  };
}

function putContents(ctx: RestContext, repo: Repo, path: string, body: unknown): RestResult {
  if (path === '') return err(422, 'Validation Failed: path is required');
  if (typeof body !== 'object' || body === null) return err(400, 'Invalid request body');
  const input = body as Record<string, unknown>;
  const message = typeof input.message === 'string' ? input.message : 'update';
  const contentB64 = typeof input.content === 'string' ? input.content : '';
  if (contentB64 === '') return err(422, 'Validation Failed: content is required');
  const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  if (!repo.refs.has(ref)) {
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) repo.refs.set(ref, baseTip);
  }
  const files = branchFiles(repo, branch);
  const existing = files.get(path);
  const sha = typeof input.sha === 'string' ? input.sha : undefined;
  if (sha !== undefined) {
    if (!existing || existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
  } else if (existing) {
    return err(422, 'Validation Failed: sha is required to update a file');
  }
  const bytes = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
  const blobOid = putObject(repo, 'blob', bytes);
  files.set(path, { oid: blobOid, mode: existing?.mode ?? '100644' });
  const commitSha = commitFiles(repo, branch, files, message);
  const created = existing === undefined;
  const treeOid = tipTree(repo, commitSha) ?? '';
  return ok(created ? 201 : 200, {
    content: {
      name: path.split('/').pop() ?? path,
      path,
      sha: blobOid,
      size: bytes.length,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
      type: 'file',
      encoding: 'base64',
      content: contentB64,
    },
    commit: {
      sha: commitSha,
      node_id: `C_${commitSha}`,
      message,
      author: { name: ctx.viewer.name, email: ctx.viewer.email, date: FIXED_ISO },
      committer: { name: ctx.viewer.name, email: ctx.viewer.email, date: FIXED_ISO },
      tree: { sha: treeOid, url: '' },
      parents: [],
      url: '',
      html_url: '',
    },
  });
}

function deleteContents(ctx: RestContext, repo: Repo, path: string, body: unknown): RestResult {
  if (path === '') return err(422, 'Validation Failed: path is required');
  const branch =
    typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).branch === 'string'
      ? ((body as Record<string, unknown>).branch as string)
      : repo.defaultBranch;
  const message =
    typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).message === 'string'
      ? ((body as Record<string, unknown>).message as string)
      : 'delete';
  const sha =
    typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).sha === 'string'
      ? ((body as Record<string, unknown>).sha as string)
      : undefined;
  const files = branchFiles(repo, branch);
  const existing = files.get(path);
  if (!existing) return err(404, 'Not Found');
  if (sha !== undefined && existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
  files.delete(path);
  const commitSha = commitFiles(repo, branch, files, message);
  return ok(200, {
    commit: {
      sha: commitSha,
      node_id: `C_${commitSha}`,
      message,
      author: { name: ctx.viewer.name, email: ctx.viewer.email, date: FIXED_ISO },
      committer: { name: ctx.viewer.name, email: ctx.viewer.email, date: FIXED_ISO },
      tree: { sha: tipTree(repo, commitSha) ?? '', url: '' },
      parents: [],
      url: '',
      html_url: '',
    },
  });
}

function pullFiles(ctx: RestContext, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const lookup = (oid: string) => repo.objects.get(oid);
  const baseTree = tipTree(repo, pull.base.sha);
  const headTree = tipTree(repo, pull.head.sha);
  if (baseTree === null || headTree === null) return [];
  const baseFiles = flattenTree(lookup, baseTree);
  const headFiles = flattenTree(lookup, headTree);
  const changes = diffFiles(baseFiles, headFiles);
  return changes.map((change) => {
    const newBlob = change.newOid !== null ? repo.objects.get(change.newOid) : undefined;
    const oldBlob = change.oldOid !== null ? repo.objects.get(change.oldOid) : undefined;
    const additions = change.status === 'removed' ? 0 : lineCount(newBlob?.data ?? Buffer.alloc(0));
    const deletions = change.status === 'added' ? 0 : lineCount(oldBlob?.data ?? Buffer.alloc(0));
    return {
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: '',
      raw_url: '',
      contents_url: '',
    };
  });
}

export function mergePull(ctx: RestContext, repo: Repo, pull: Pull): RestResult {
  if (pull.state === 'closed') {
    return err(405, pull.merged ? 'Pull Request is already merged' : 'Pull Request is closed');
  }
  const headTip = repo.refs.get(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  if (!repo.objects.has(headTip) || !repo.objects.has(baseTip)) return err(405, 'Merge failed: missing objects');
  if (!pullMergeable(repo, pull)) return err(405, 'Merge conflict: the pull request cannot be merged cleanly');
  const lookup = (oid: string) => repo.objects.get(oid);
  const base = mergeBase(lookup, headTip, baseTip);
  const baseTree = base !== null ? tipTree(repo, base) : null;
  const headTree = tipTree(repo, headTip);
  const baseTipTree = tipTree(repo, baseTip);
  if (headTree === null || baseTipTree === null) return err(405, 'Merge failed');
  const baseFiles = baseTree !== null ? flattenTree(lookup, baseTree) : new Map();
  const headFiles = flattenTree(lookup, headTree);
  const baseTipFiles = flattenTree(lookup, baseTipTree);
  const merged = new Map(baseTipFiles);
  for (const change of diffFiles(baseFiles, headFiles)) {
    if (change.newOid === null) merged.delete(change.path);
    else merged.set(change.path, { oid: change.newOid, mode: '100644' });
  }
  const treeOid = buildTreeFromFiles(repo, merged);
  const timestamp = 1_700_000_000 + repo.commitSeq++;
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}\n\n${pull.title}\n`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: forgeIdentity(),
    timestamp,
  });
  const mergeSha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base.ref}`, mergeSha);
  invalidatePackCache(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = FIXED_ISO;
  pull.closed_at = FIXED_ISO;
  pull.merge_commit_sha = mergeSha;
  pull.base.sha = mergeSha;
  pull.mergeable = true;
  return ok(200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
}

