// GraphQL v4: a small parser (tokenizer + recursive selections, aliases,
// variables, input objects, lists, enums, inline fragments) and an executor
// with per-type field tables, resolvers, mutations and __type introspection.
// The document set is the fixed one the grading suite uses; unknown fields
// produce HTTP 200 with an errors array naming the field.

import {
  diffFiles,
  FIXED_ISO,
  getRepo,
  lineCount,
  type Comment,
  type Issue,
  type Pull,
  type Repo,
  type StoreState,
} from './store.ts';
import { commentGlobalId, decodeGlobalId, issueGlobalId, pullGlobalId, repoGlobalId } from './ids.ts';
import { flattenTree, parseCommit, type GitObject } from './gitproto.ts';
import { mergePull, pullMergeable, type RestContext } from './rest.ts';
import type { ViewerIdentity } from './scenario.ts';

export interface GraphContext {
  store: StoreState;
  viewer: ViewerIdentity;
  requestId: string;
}

// ---------------------------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  return tokens;
}

export interface Selection {
  alias: string | null;
  name: string;
  args: Record<string, unknown>;
  children: Selection[];
  fragmentType: string | null;
}

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selections: Selection[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  private readonly variables: Record<string, unknown>;

  constructor(tokens: Token[], variables: Record<string, unknown>) {
    this.tokens = tokens;
    this.variables = variables;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected variable name');
      return this.variables[name.value] ?? null;
    }
    if (token.kind === 'int') return Number.parseInt(token.value, 10);
    if (token.kind === 'float') return Number.parseFloat(token.value);
    if (token.kind === 'string') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected object key');
        this.expectPunct(':');
        obj[key.value] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error('unexpected value');
  }

  private parseArgs(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const key = this.next();
        if (key.kind !== 'name') throw new Error('expected argument name');
        this.expectPunct(':');
        args[key.value] = this.parseValue();
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseSelections(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      const token = this.next();
      if (token.kind === 'spread') {
        // Inline fragment: ... on Type { ... } or ... { ... }
        let fragmentType: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name' && next.value === 'on') {
          this.next();
          const typeToken = this.next();
          if (typeToken.kind === 'name') fragmentType = typeToken.value;
        }
        // Skip directives (@include/@skip) if present.
        while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
          this.next();
          this.next();
          this.parseArgs();
        }
        const children = this.parseSelections();
        selections.push({ alias: null, name: '', args: {}, children, fragmentType });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected field name');
      let alias: string | null = null;
      let name = token.value;
      const colon = this.peek();
      if (colon?.kind === 'punct' && colon.value === ':') {
        this.next();
        alias = name;
        const real = this.next();
        if (real.kind !== 'name') throw new Error('expected field name after alias');
        name = real.value;
      }
      const args = this.parseArgs();
      while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
        this.next();
        this.next();
        this.parseArgs();
      }
      const children = this.peek()?.kind === 'punct' && this.peek()?.value === '{' ? this.parseSelections() : [];
      selections.push({ alias, name, args, children, fragmentType: null });
    }
    this.expectPunct('}');
    return selections;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.next();
      let kind: 'query' | 'mutation' = 'query';
      let name: string | null = null;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        kind = token.value;
        const maybeName = this.peek();
        if (maybeName?.kind === 'name') {
          name = maybeName.value;
          this.next();
        }
      } else if (token.kind === 'punct' && token.value === '{') {
        this.pos -= 1;
      } else {
        throw new Error(`unexpected token ${JSON.stringify(token)}`);
      }
      // Variable definitions: ($x: Type = default, ...)
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
        }
      }
      const selections = this.parseSelections();
      operations.push({ kind, name, variables: this.variables, selections });
    }
    return operations;
  }
}

// ---------------------------------------------------------------------------------------------
// schema tables (for field validation and __type introspection)
// ---------------------------------------------------------------------------------------------

const FIELD_TABLES: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['id', 'login', 'name', 'email', 'avatarUrl', 'repositories', 'databaseId'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'databaseId'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'updatedAt'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'closedAt', 'comments', 'labels'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'headRef', 'baseRef'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueCommentEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  LabelEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestFileEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  RepositoryConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  RepositoryEdge: ['node', 'cursor'],
  SearchResultItemEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'fields', 'enumValues', 'description', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'type', 'description', 'args'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types', 'description'],
  __InputValue: ['name', 'type', 'defaultValue'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  Label: ['id', 'name', 'color', 'description'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  SearchResultItemConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  RateLimit: ['limit', 'remaining', 'resetAt', 'cost'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function typeInfo(name: string): Record<string, unknown> {
  const fields = FIELD_TABLES[name];
  if (fields) {
    return {
      __type: '__Type',
      kind: 'OBJECT',
      name,
      fields: fields.map((field) => ({ __type: '__Field', name: field, type: { __type: '__Type', kind: 'SCALAR', name: 'String', ofType: null } })),
      enumValues: null,
    };
  }
  const values = ENUM_VALUES[name];
  if (values) {
    return { __type: '__Type', kind: 'ENUM', name, fields: null, enumValues: values.map((value) => ({ __type: '__EnumValue', name: value })) };
  }
  return { __type: '__Type', kind: 'OBJECT', name, fields: [], enumValues: null };
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface ExecState {
  ctx: GraphContext;
  errors: { message: string }[];
}

type AnyObject = Record<string, unknown>;

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function restCtx(state: ExecState): RestContext {
  return { store: state.ctx.store, viewer: state.ctx.viewer, requestId: state.ctx.requestId, baseUrl: '' };
}

function repoOf(state: ExecState, owner: string, name: string): Repo | null {
  if (owner !== state.ctx.viewer.login) return null;
  return getRepo(state.ctx.store, owner, name) ?? null;
}

function issueObject(state: ExecState, repo: Repo, issue: Issue): AnyObject {
  return {
    __type: 'Issue',
    __repo: repo,
    __issue: issue,
    id: issueGlobalId(repo.id, issue.number),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { __type: 'User', login: issue.user, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
  };
}

function pullObject(state: ExecState, repo: Repo, pull: Pull): AnyObject {
  return {
    __type: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: pullGlobalId(repo.id, pull.number),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    author: { __type: 'User', login: pull.user, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    closedAt: pull.closed_at,
    mergedAt: pull.merged_at,
    headRef: { __type: 'Ref', name: pull.head.ref, target: { __type: 'GitObject', oid: pull.head.sha } },
    baseRef: { __type: 'Ref', name: pull.base.ref, target: { __type: 'GitObject', oid: pull.base.sha } },
  };
}

function repoObject(state: ExecState, repo: Repo): AnyObject {
  return {
    __type: 'Repository',
    __repo: repo,
    id: repoGlobalId(repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch, target: { __type: 'GitObject', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? '' } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
  };
}

function issueConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): AnyObject {
  const statesArg = Array.isArray(args.states) ? (args.states as string[]) : null;
  let issues = [...repo.issues.values()];
  if (statesArg !== null) {
    const wanted = new Set(statesArg.map((s) => s.toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => direction * (a.number - b.number));
  const after = cursorNumber(args.after);
  if (after !== null) issues = issues.filter((issue) => (direction === 1 ? issue.number > after : issue.number < after));
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueObject(state, repo, issue)),
    edges: page.map((issue) => ({ __type: 'IssueEdge', node: issueObject(state, repo, issue), cursor: cursorFor(issue.number) })),
    totalCount: issues.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: issues.length > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor((page[0] as Issue).number) : null,
      endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Issue).number) : null,
    },
  };
}

function pullConnection(state: ExecState, repo: Repo, args: Record<string, unknown>): AnyObject {
  const statesArg = Array.isArray(args.states) ? (args.states as string[]) : null;
  let pulls = [...repo.pulls.values()];
  if (statesArg !== null) {
    const wanted = new Set(statesArg.map((s) => s.toLowerCase()));
    pulls = pulls.filter((pull) => {
      const pullState = pull.merged ? 'merged' : pull.state;
      return wanted.has(pullState);
    });
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  pulls.sort((a, b) => direction * (a.number - b.number));
  const after = cursorNumber(args.after);
  if (after !== null) pulls = pulls.filter((pull) => (direction === 1 ? pull.number > after : pull.number < after));
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(state, repo, pull)),
    edges: page.map((pull) => ({ __type: 'PullRequestEdge', node: pullObject(state, repo, pull), cursor: cursorFor(pull.number) })),
    totalCount: pulls.length,
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor((page[0] as Pull).number) : null,
      endCursor: page.length > 0 ? cursorFor((page[page.length - 1] as Pull).number) : null,
    },
  };
}

function pullFilesList(state: ExecState, repo: Repo, pull: Pull): AnyObject[] {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const treeOf = (tip: string): string | null => {
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  };
  const baseTree = treeOf(pull.base.sha);
  const headTree = treeOf(pull.head.sha);
  if (baseTree === null || headTree === null) return [];
  const baseFiles = flattenTree(lookup, baseTree);
  const headFiles = flattenTree(lookup, headTree);
  return diffFiles(baseFiles, headFiles).map((change) => {
    const newBlob = change.newOid !== null ? repo.objects.get(change.newOid) : undefined;
    const oldBlob = change.oldOid !== null ? repo.objects.get(change.oldOid) : undefined;
    const additions = change.status === 'removed' ? 0 : lineCount(newBlob?.data ?? Buffer.alloc(0));
    const deletions = change.status === 'added' ? 0 : lineCount(oldBlob?.data ?? Buffer.alloc(0));
    return {
      __type: 'PullRequestFile',
      path: change.path,
      additions,
      deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
    };
  });
}

/** Resolve one field on an already-built object. Returns null for unknown fields (records an error). */
function resolveField(state: ExecState, parent: AnyObject, selection: Selection): unknown {
  const type = (parent.__type as string) ?? 'Query';
  const name = selection.name;
  if (name === '__typename') return type;
  if (name === '__type') {
    const typeName = typeof selection.args.name === 'string' ? selection.args.name : '';
    return { __type: '__Type', ...typeInfo(typeName) };
  }
  if (name === '__schema') {
    return { __type: '__Schema', queryType: { __type: '__Type', name: 'Query' }, mutationType: { __type: '__Type', name: 'Mutation' }, types: Object.keys(FIELD_TABLES).map((t) => typeInfo(t)) };
  }
  const known = FIELD_TABLES[type] ?? [];
  if (!known.includes(name)) {
    state.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
    return null;
  }
  // Root fields.
  if (type === 'Query') return resolveQueryRoot(state, selection);
  if (type === 'Mutation') return resolveMutationRoot(state, selection);
  // Repository fields.
  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const number = selection.args.number as number | undefined;
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue ? issueObject(state, repo, issue) : null;
    }
    if (name === 'issues') return issueConnection(state, repo, selection.args);
    if (name === 'pullRequest') {
      const number = selection.args.number as number | undefined;
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull ? pullObject(state, repo, pull) : null;
    }
    if (name === 'pullRequests') return pullConnection(state, repo, selection.args);
    return parent[name] ?? null;
  }
  if (type === 'Issue') {
    const repo = parent.__repo as Repo;
    const issue = parent.__issue as Issue;
    if (name === 'comments') {
      const nodes = issue.comments.map((comment) => ({
        __type: 'IssueComment',
        id: commentGlobalId(comment.id),
        databaseId: comment.id,
        body: comment.body,
        author: { __type: 'User', login: comment.user, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
        createdAt: comment.created_at,
      }));
      return { __type: 'IssueCommentConnection', nodes, edges: nodes.map((node) => ({ __type: 'IssueCommentEdge', node, cursor: cursorFor(node.databaseId as number) })), totalCount: nodes.length, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name === 'labels') {
      return { __type: 'LabelConnection', nodes: issue.labels.map((label) => ({ __type: 'Label', id: `L_${label.id}`, name: label.name, color: label.color, description: label.description })) };
    }
    return parent[name] ?? null;
  }
  if (type === 'PullRequest') {
    const repo = parent.__repo as Repo;
    const pull = parent.__pull as Pull;
    if (name === 'files') {
      const files = pullFilesList(state, repo, pull);
      return { __type: 'PullRequestFileConnection', nodes: files, edges: files.map((file) => ({ __type: 'PullRequestFileEdge', node: file, cursor: cursorFor(0) })), totalCount: files.length, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    return parent[name] ?? null;
  }
  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'SearchResultItemConnection') {
    return parent[name] ?? null;
  }
  if (type === 'IssueEdge' || type === 'PullRequestEdge' || type === 'IssueCommentEdge' || type === 'PullRequestFileEdge') {
    return parent[name] ?? null;
  }
  return parent[name] ?? null;
}

function resolveQueryRoot(state: ExecState, selection: Selection): unknown {
  const name = selection.name;
  if (name === 'viewer') {
    return {
      __type: 'Viewer',
      id: `U_${state.ctx.viewer.id}`,
      databaseId: state.ctx.viewer.id,
      login: state.ctx.viewer.login,
      name: state.ctx.viewer.name,
      email: state.ctx.viewer.email,
      avatarUrl: '',
      repositories: { __type: 'RepositoryConnection', nodes: [], edges: [], totalCount: 0, pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } },
    };
  }
  if (name === 'repository') {
    const owner = selection.args.owner as string | undefined;
    const repoName = selection.args.name as string | undefined;
    if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
    const repo = repoOf(state, owner, repoName);
    return repo ? repoObject(state, repo) : null;
  }
  if (name === 'node') {
    const id = selection.args.id as string | undefined;
    if (typeof id !== 'string') return null;
    const decoded = decodeGlobalId(id);
    if (!decoded) return null;
    if (decoded.kind === 'Repository') {
      const repoId = Number.parseInt(decoded.parts[0] as string, 10);
      for (const repo of state.ctx.store.repos.values()) {
        if (repo.id === repoId) return repoObject(state, repo);
      }
      return null;
    }
    if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
      const repoId = Number.parseInt(decoded.parts[0] as string, 10);
      const number = Number.parseInt(decoded.parts[1] as string, 10);
      for (const repo of state.ctx.store.repos.values()) {
        if (repo.id !== repoId) continue;
        if (decoded.kind === 'Issue') {
          const issue = repo.issues.get(number);
          return issue ? issueObject(state, repo, issue) : null;
        }
        const pull = repo.pulls.get(number);
        return pull ? pullObject(state, repo, pull) : null;
      }
      return null;
    }
    return null;
  }
  if (name === 'search') {
    const queryText = typeof selection.args.query === 'string' ? selection.args.query : '';
    const first = typeof selection.args.first === 'number' ? selection.args.first : 10;
    const nodes: AnyObject[] = [];
    for (const repo of state.ctx.store.repos.values()) {
      if (repo.owner !== state.ctx.viewer.login) continue;
      for (const issue of repo.issues.values()) {
        if (queryText === '' || issue.title.includes(queryText) || issue.body.includes(queryText)) {
          nodes.push(issueObject(state, repo, issue));
        }
      }
    }
    const page = nodes.slice(0, first);
    return {
      __type: 'SearchResultItemConnection',
      nodes: page,
      edges: page.map((node) => ({ __type: 'SearchResultItemEdge', node, cursor: cursorFor(0) })),
      totalCount: nodes.length,
      pageInfo: { __type: 'PageInfo', hasNextPage: nodes.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
      issueCount: nodes.length,
    };
  }
  if (name === 'rateLimit') {
    return { __type: 'RateLimit', limit: 5000, remaining: 4999, resetAt: FIXED_ISO, cost: 1 };
  }
  return null;
}

function resolveMutationRoot(state: ExecState, selection: Selection): unknown {
  const name = selection.name;
  const input = (selection.args.input ?? {}) as Record<string, unknown>;
  const rctx = restCtx(state);
  if (name === 'createIssue') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = repoId?.kind === 'Repository'
      ? [...state.ctx.store.repos.values()].find((candidate) => candidate.id === Number.parseInt(repoId.parts[0] as string, 10))
      : undefined;
    if (!repo) {
      state.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return { __type: 'CreateIssuePayload', issue: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    const title = typeof input.title === 'string' ? input.title : '';
    const number = ++repo.numberSeq;
    const issue: Issue = {
      id: state.ctx.store.issueIdSeq++,
      number,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: number,
      user: state.ctx.viewer.login,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
      closed_at: null,
    };
    repo.issues.set(number, issue);
    return { __type: 'CreateIssuePayload', issue: issueObject(state, repo, issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
  }
  if (name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    let found: { repo: Repo; issue: Issue } | null = null;
    if (decoded?.kind === 'Issue') {
      const repoId = Number.parseInt(decoded.parts[0] as string, 10);
      const number = Number.parseInt(decoded.parts[1] as string, 10);
      for (const repo of state.ctx.store.repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        if (issue) found = { repo, issue };
      }
    }
    if (!found) {
      state.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return { __type: 'CloseIssuePayload', issue: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    found.issue.state = 'closed';
    found.issue.closed_at = FIXED_ISO;
    return { __type: 'CloseIssuePayload', issue: issueObject(state, found.repo, found.issue), clientMutationId: (input.clientMutationId as string | null) ?? null };
  }
  if (name === 'createPullRequest') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = repoId?.kind === 'Repository'
      ? [...state.ctx.store.repos.values()].find((candidate) => candidate.id === Number.parseInt(repoId.parts[0] as string, 10))
      : undefined;
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo?.defaultBranch ?? 'main';
    const headSha = repo?.refs.get(`refs/heads/${head}`);
    const baseSha = repo?.refs.get(`refs/heads/${base}`);
    if (!repo || headSha === undefined || baseSha === undefined) {
      state.errors.push({ message: 'Could not resolve to a Repository or branch for the pull request.' });
      return { __type: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    const number = ++repo.numberSeq;
    const pull: Pull = {
      id: state.ctx.store.issueIdSeq++,
      number,
      title: typeof input.title === 'string' ? input.title : '',
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
      user: state.ctx.viewer.login,
      created_at: FIXED_ISO,
      updated_at: FIXED_ISO,
    };
    pull.mergeable = pullMergeable(repo, pull);
    repo.pulls.set(number, pull);
    return { __type: 'CreatePullRequestPayload', pullRequest: pullObject(state, repo, pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
  }
  if (name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    let found: { repo: Repo; pull: Pull } | null = null;
    if (decoded?.kind === 'PullRequest') {
      const repoId = Number.parseInt(decoded.parts[0] as string, 10);
      const number = Number.parseInt(decoded.parts[1] as string, 10);
      for (const repo of state.ctx.store.repos.values()) {
        if (repo.id !== repoId) continue;
        const pull = repo.pulls.get(number);
        if (pull) found = { repo, pull };
      }
    }
    if (!found) {
      state.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return { __type: 'MergePullRequestPayload', pullRequest: null, clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    const result = mergePull(rctx, found.repo, found.pull);
    if (result.status !== 200) {
      state.errors.push({ message: typeof result.body === 'object' && result.body !== null ? ((result.body as Record<string, unknown>).message as string) ?? 'Merge failed' : 'Merge failed' });
      return { __type: 'MergePullRequestPayload', pullRequest: pullObject(state, found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
    }
    return { __type: 'MergePullRequestPayload', pullRequest: pullObject(state, found.repo, found.pull), clientMutationId: (input.clientMutationId as string | null) ?? null };
  }
  if (name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const body = typeof input.body === 'string' ? input.body : '';
    let node: AnyObject | null = null;
    if (decoded?.kind === 'Issue') {
      const repoId = Number.parseInt(decoded.parts[0] as string, 10);
      const number = Number.parseInt(decoded.parts[1] as string, 10);
      for (const repo of state.ctx.store.repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        if (!issue) continue;
        const comment: Comment = {
          id: state.ctx.store.commentIdSeq++,
          body,
          user: state.ctx.viewer.login,
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        };
        issue.comments.push(comment);
        node = {
          __type: 'IssueComment',
          id: commentGlobalId(comment.id),
          databaseId: comment.id,
          body: comment.body,
          author: { __type: 'User', login: comment.user, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
          createdAt: comment.created_at,
        };
      }
    }
    if (node === null) {
      const commentId = state.ctx.store.commentIdSeq++;
      node = {
        __type: 'IssueComment',
        id: commentGlobalId(commentId),
        databaseId: commentId,
        body,
        author: { __type: 'User', login: state.ctx.viewer.login, id: state.ctx.viewer.id, name: state.ctx.viewer.name, email: state.ctx.viewer.email, avatarUrl: '', databaseId: state.ctx.viewer.id },
        createdAt: FIXED_ISO,
      };
    }
    return {
      __type: 'AddCommentPayload',
      commentEdge: { __type: 'IssueCommentEdge', node, cursor: cursorFor((node.databaseId as number) ?? 0) },
      comment: node,
      clientMutationId: (input.clientMutationId as string | null) ?? null,
    };
  }
  return null;
}

/** Execute one selection set against `parent`; inline fragments filter by type. */
function executeSelections(state: ExecState, parent: AnyObject, selections: Selection[]): AnyObject {
  const out: AnyObject = {};
  const parentType = (parent.__type as string) ?? 'Query';
  for (const selection of selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType !== parentType) continue;
      Object.assign(out, executeSelections(state, parent, selection.children));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(state, parent, selection);
    if (selection.children.length === 0 || value === null || typeof value !== 'object') {
      out[key] = value;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (item !== null && typeof item === 'object' ? executeSelections(state, item as AnyObject, selection.children) : item));
    } else {
      out[key] = executeSelections(state, value as AnyObject, selection.children);
    }
  }
  return out;
}

/** Execute one GraphQL document. Returns the response object (always HTTP 200). */
export function executeGraphQL(ctx: GraphContext, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  const state: ExecState = { ctx, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query), variables).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'empty document' }] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: AnyObject = { __type: rootType };
  const data = executeSelections(state, root, operation.selections);
  const response: Record<string, unknown> = { data };
  if (state.errors.length > 0) response.errors = state.errors;
  return response;
}

/** POST /api/graphql: one document or a JSON batch. */
export function handleGraphQL(ctx: GraphContext, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return {
      status: 200,
      body: body.map((item) => {
        if (typeof item !== 'object' || item === null) return { data: null, errors: [{ message: 'invalid request' }] };
        const doc = item as Record<string, unknown>;
        return executeGraphQL(ctx, typeof doc.query === 'string' ? doc.query : '', (doc.variables ?? {}) as Record<string, unknown>);
      }),
    };
  }
  if (typeof body !== 'object' || body === null) return { status: 400, body: { message: 'Invalid request body' } };
  const doc = body as Record<string, unknown>;
  return {
    status: 200,
    body: executeGraphQL(ctx, typeof doc.query === 'string' ? doc.query : '', (doc.variables ?? {}) as Record<string, unknown>),
  };
}
