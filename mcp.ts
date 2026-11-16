// MCP (Model Context Protocol), modern era 2026-07-28: server/discover,
// initialize, tools/list and tools/call over plain JSON-RPC 2.0. The six tools
// act on the same store as REST and GraphQL. tools/list is built from a
// frozen constant so two calls are byte-identical.

import { createRepoRecord, getRepo, type Issue, type Pull, type Repo, type StoreState } from './store.ts';
import { issueJson, mergePull, pullJson, pullMergeable, repoJson, type RestContext } from './rest.ts';
import type { ViewerIdentity } from './scenario.ts';

export interface McpContext {
  store: StoreState;
  viewer: ViewerIdentity;
  requestId: string;
}

const SERVER_NAME = 'github-core-forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner of the repository (defaults to the authenticated user).' },
      }),
      required: Object.freeze(['name']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      }),
      required: Object.freeze(['owner', 'repo']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch with the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: Object.freeze({
      type: 'object' as const,
      properties: Object.freeze({
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request.' },
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
      additionalProperties: false,
    }),
  }),
]);

function restCtx(ctx: McpContext): RestContext {
  return { store: ctx.store, viewer: ctx.viewer, requestId: ctx.requestId, baseUrl: '' };
}

function toolResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function repoOf(ctx: McpContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.viewer.login) return null;
  return getRepo(ctx.store, owner, name) ?? null;
}

function missingArgs(args: Record<string, unknown>, required: readonly string[]): string | null {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  }
  return null;
}

/** Run one tool. Returns {result} or {error} (error = {message}). */
function callTool(ctx: McpContext, name: string, args: Record<string, unknown>): { result?: Record<string, unknown>; error?: string } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `unknown tool: ${name}` };
  const missing = missingArgs(args, tool.inputSchema.required);
  if (missing !== null) return { result: toolError(`missing required argument: ${missing}`) };

  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (getRepo(ctx.store, ctx.viewer.login, repoName) !== undefined) {
      return { result: toolError(`repository ${repoName} already exists`) };
    }
    const repo = createRepoRecord(ctx.store, ctx.viewer.login, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return { result: toolResult(repoJson(restCtx(ctx), repo)) };
  }

  const owner = String(args.owner);
  const repoName = String(args.repo);
  const repo = repoOf(ctx, owner, repoName);
  if (name === 'get_repo') {
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    return { result: toolResult(repoJson(restCtx(ctx), repo)) };
  }
  if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };

  if (name === 'create_issue') {
    const number = ++repo.numberSeq;
    const issue: Issue = {
      id: ctx.store.issueIdSeq++,
      number,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: number,
      user: ctx.viewer.login,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      closed_at: null,
    };
    repo.issues.set(number, issue);
    return { result: toolResult(issueJson(restCtx(ctx), repo, issue)) };
  }
  if (name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => b.number - a.number);
    return { result: toolResult({ issues: issues.map((issue) => issueJson(restCtx(ctx), repo, issue)), total_count: issues.length }) };
  }
  if (name === 'create_pull_request') {
    const head = String(args.head);
    const base = String(args.base);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return { result: toolError('head or base branch does not exist') };
    }
    const number = ++repo.numberSeq;
    const pull: Pull = {
      id: ctx.store.issueIdSeq++,
      number,
      title: String(args.title),
      body: typeof args.body === 'string' ? args.body : '',
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
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    };
    pull.mergeable = pullMergeable(repo, pull);
    repo.pulls.set(number, pull);
    return { result: toolResult(pullJson(restCtx(ctx), repo, pull)) };
  }
  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pull = repo.pulls.get(number);
    if (!pull) return { result: toolError(`pull request ${number} not found`) };
    const result = mergePull(restCtx(ctx), repo, pull);
    if (result.status !== 200) {
      const message = typeof result.body === 'object' && result.body !== null ? String((result.body as Record<string, unknown>).message ?? 'merge failed') : 'merge failed';
      return { result: toolError(message) };
    }
    return { result: toolResult(pullJson(restCtx(ctx), repo, pull)) };
  }
  return { error: `unknown tool: ${name}` };
}

export interface McpResult {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle one JSON-RPC request object. */
export function handleMcpRequest(ctx: McpContext, request: unknown): McpResult {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request') };
  }
  const req = request as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (typeof req.params === 'object' && req.params !== null ? req.params : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-06-18', '2025-03-26'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }),
    };
  }
  if (method === 'initialize') {
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2026-07-28',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
    };
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}) };
  }
  if (method === 'tools/list') {
    return {
      status: 200,
      body: rpcResult(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      }),
    };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    const outcome = callTool(ctx, name, args);
    if (outcome.error !== undefined) {
      return { status: 200, body: rpcError(id, -32601, outcome.error) };
    }
    return { status: 200, body: rpcResult(id, outcome.result) };
  }
  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
}

/** POST /mcp: a JSON-RPC request (or a batch array). Non-JSON bodies are 400/-32700. */
export function handleMcp(ctx: McpContext, body: unknown, parseFailed: boolean): McpResult {
  if (parseFailed) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((item) => handleMcpRequest(ctx, item).body) };
  }
  return handleMcpRequest(ctx, body);
}
