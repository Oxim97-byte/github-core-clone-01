// The HTTP server: one process, one store, four surfaces (REST v3, GraphQL v4,
// MCP, git smart HTTP) plus /healthz. Auth is Bearer $MAKEFUN_SHOP_TOKEN:
// when the env var is set it must match exactly; when it is empty any
// non-empty Bearer passes; a missing header is always 401. /healthz is open.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, getRepo, loadSnapshot, saveSnapshot, startSnapshotLoop, type StoreState } from './store.ts';
import { viewerIdentity } from './scenario.ts';
import { handleRest, type RestContext } from './rest.ts';
import { infoRefs, receivePack, uploadPack, type GitResult } from './gitapi.ts';
import { handleGraphQL, type GraphContext } from './graphql.ts';
import { handleMcp, type McpContext } from './mcp.ts';

const MAX_BODY_BYTES = 128 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function readBody(req: IncomingMessage): Promise<{ body: Buffer; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', () => resolve({ body: Buffer.alloc(0), tooLarge }));
  });
}

/** Parse a request body as JSON. Empty body -> null; invalid JSON -> parseFailed. */
function parseJson(buffer: Buffer): { value: unknown; parseFailed: boolean } {
  if (buffer.length === 0) return { value: null, parseFailed: false };
  try {
    return { value: JSON.parse(buffer.toString('utf8')) as unknown, parseFailed: false };
  } catch {
    return { value: null, parseFailed: true };
  }
}

export function createApp(): Server {
  const store: StoreState = loadSnapshot() ?? createStore();
  const viewer = viewerIdentity();
  let dirty = false;
  const stopSnapshotLoop = startSnapshotLoop(
    store,
    () => dirty,
    () => {
      dirty = false;
    },
  );

  const restCtx = (req: IncomingMessage, requestId: string): RestContext => ({
    store,
    viewer,
    requestId,
    baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
  });
  const graphCtx = (requestId: string): GraphContext => ({ store, viewer, requestId });
  const mcpCtx = (requestId: string): McpContext => ({ store, viewer, requestId });

  function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown): void {
    const payload = body === null ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': requestId,
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  function sendGit(res: ServerResponse, requestId: string, result: GitResult): void {
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'x-github-request-id': requestId,
      'cache-control': 'no-store',
    });
    res.end(result.body);
  }

  const server = createServer(async (req, res) => {
    const requestId = `req-${++store.requestSeq}`;
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      const segments = url.pathname.split('/').filter((part) => part !== '');

      if (segments.length === 1 && segments[0] === 'healthz') {
        sendJson(res, requestId, 200, { ok: true });
        return;
      }

      if (!authorized(req)) {
        sendJson(res, requestId, 401, { message: 'Requires authentication' });
        return;
      }

      // REST v3.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        const restSegments = segments.slice(2);
        const { body, tooLarge } = await readBody(req);
        if (tooLarge) {
          sendJson(res, requestId, 413, { message: 'Request body too large' });
          return;
        }
        const parsed = parseJson(body);
        if (parsed.parseFailed) {
          sendJson(res, requestId, 400, { message: 'Invalid JSON body' });
          return;
        }
        if (method !== 'GET') dirty = true;
        const result = handleRest(restCtx(req, requestId), method, restSegments, url.searchParams, parsed.value);
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          'x-github-request-id': requestId,
          'cache-control': 'no-store',
        };
        if (result.headers) Object.assign(headers, result.headers);
        res.writeHead(result.status, headers);
        res.end(JSON.stringify(result.body));
        return;
      }

      // GraphQL v4.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
        if (method !== 'POST') {
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }
        const { body, tooLarge } = await readBody(req);
        if (tooLarge) {
          sendJson(res, requestId, 413, { message: 'Request body too large' });
          return;
        }
        const parsed = parseJson(body);
        if (parsed.parseFailed) {
          sendJson(res, requestId, 400, { message: 'Invalid JSON body' });
          return;
        }
        dirty = true;
        const result = handleGraphQL(graphCtx(requestId), parsed.value);
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp') {
        if (method !== 'POST') {
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }
        const { body, tooLarge } = await readBody(req);
        if (tooLarge) {
          sendJson(res, requestId, 413, { message: 'Request body too large' });
          return;
        }
        const parsed = parseJson(body);
        dirty = true;
        const result = handleMcp(mcpCtx(requestId), parsed.value, parsed.parseFailed);
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const action = gitMatch[3] as string;
        const repo = owner === viewer.login ? (getRepo(store, owner, repoName) ?? null) : null;
        const gitProtocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
        if (action === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, requestId, 400, { message: 'Invalid service' });
            return;
          }
          sendGit(res, requestId, infoRefs(repo, service, gitProtocol));
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, requestId, 413, { message: 'Request body too large' });
            return;
          }
          sendGit(res, requestId, uploadPack(repo, body, gitProtocol));
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const { body, tooLarge } = await readBody(req);
          if (tooLarge) {
            sendJson(res, requestId, 413, { message: 'Request body too large' });
            return;
          }
          dirty = true;
          sendGit(res, requestId, receivePack(repo, body));
          return;
        }
        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, requestId, 404, { message: 'Not Found' });
    } catch {
      try {
        sendJson(res, requestId, 500, { message: 'Internal Server Error' });
      } catch {
        // The socket is already gone.
      }
    }
  });

  server.on('close', () => {
    stopSnapshotLoop();
    if (dirty) saveSnapshot(store);
  });

  return server;
}
