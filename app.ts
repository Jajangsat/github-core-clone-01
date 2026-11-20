// The forge's HTTP surface: one Node http server over the shared in-memory store.
//
//   GET  /healthz                                  -> 200 {"ok":true} (no auth)
//   GET  /meta                                     -> {"installed_version":"1.0.0"} (no auth)
//   GET  /api/v3/                                  -> the API root (no auth)
//   /<owner>/<repo>.git/info/refs                 -> git smart-HTTP advertisement
//   /<owner>/<repo>.git/git-upload-pack            -> protocol v2 fetch / v0 fallback
//   /<owner>/<repo>.git/git-receive-pack           -> push (v0)
//   /api/v3/...                                    -> REST v3
//   POST /api/graphql                             -> GraphQL v4
//   POST /mcp                                     -> MCP over streamable HTTP
//
// Auth: every API call carries `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`; a missing or
// wrong token answers 401. When the env token is unset (local testing only) any non-empty
// Bearer is accepted. Every JSON reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { executeGraphQL } from './graphql.ts';
import { handleInfoRefs, handleLsRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The Bearer token this process expects; empty when unset (local testing only). */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body, always with a request id. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Answer with raw bytes (a git response), with a request id alongside. */
function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
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

/** Read the request body fully as bytes; git needs the raw pack, the rest parse JSON. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The Bearer token on the request, or null when the header is absent or malformed. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

/** True when the request is allowed past the auth gate. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (EXPECTED_TOKEN === '') return true;
  return token === EXPECTED_TOKEN;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // The protocol suite reads the installed version here.
      if (method === 'GET' && path === '/meta') {
        sendJson(res, 200, { installed_version: '1.0.0' });
        return;
      }

      // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/{info/refs, git-upload-pack, git-receive-pack}.
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch !== null) {
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const endpoint = gitMatch[3] as string;
        const body = await readBody(req);
        if (endpoint === 'info/refs') {
          const service = query.get('service') ?? '';
          const gitProtocolV2 = req.headers['git-protocol'] === 'version=2';
          const result = handleInfoRefs(store, owner, repoName, service, gitProtocolV2);
          sendBytes(res, result.status, result.contentType, result.body);
          return;
        }
        if (endpoint === 'git-upload-pack') {
          const isV2 = req.headers['git-protocol'] === 'version=2';
          // Protocol v2 announces itself with a `command=ls-refs` request body; v0 sends wants.
          const isLsRefs = body.length > 0 && body.toString('utf8', 0, Math.min(body.length, 64)).includes('command=ls-refs');
          const result = isV2 && isLsRefs ? handleLsRefs(store, owner, repoName, body) : handleUploadPack(store, owner, repoName, body, isV2);
          sendBytes(res, result.status, result.contentType, result.body);
          return;
        }
        const result = handleReceivePack(store, owner, repoName, body);
        sendBytes(res, result.status, result.contentType, result.body);
        return;
      }

      // Everything below is an authenticated API surface.
      if (!authorized(req)) {
        // The 401 check also covers unknown routes under /api: a missing token answers 401
        // before the route is resolved.
        if (path.startsWith('/api/') || path === '/mcp') {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const segments = restPath.split('/').filter((segment) => segment !== '').map((segment) => decodeURIComponent(segment));
        let body: unknown;
        const raw = await readBody(req);
        if (raw.length > 0) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Invalid JSON' });
            return;
          }
        }
        const host = req.headers.host ?? '127.0.0.1';
        const baseUrl = `http://${host}/api/v3`;
        const result = handleRest(store, { method, segments, query, body, baseUrl, path: restPath });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body ?? {}, result.headers ?? {});
        return;
      }

      // GraphQL v4.
      if (method === 'POST' && path === '/api/graphql') {
        const raw = await readBody(req);
        let body: unknown;
        try {
          body = raw.length === 0 ? null : JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Invalid JSON' });
          return;
        }
        const result = executeGraphQL(store, body);
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP over streamable HTTP (malformed JSON is answered inside handleMcp).
      if (method === 'POST' && path === '/mcp') {
        const raw = await readBody(req);
        const result = handleMcp(store, { method, path, body: raw });
        if (result.status === 202 || result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        sendJson(res, result.status, result.body);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch((err: unknown) => {
      // A handler must never leave a request hanging: answer 500 and keep serving.
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } catch {
        try {
          res.end();
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    });
  });
}
