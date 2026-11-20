// MCP over streamable HTTP: JSON-RPC 2.0 on POST /mcp. Supports the modern era
// (server/discover, protocol 2026-07-28) with a legacy initialize fallback, and six
// tools whose effects land in the same store the REST and GraphQL views read.

import { lineCount, nextGlobalId, nextSeq, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface McpRequest {
  method: string;
  path: string;
  body: Buffer;
}

export interface McpResponse {
  status: number;
  body: unknown;
}

interface RpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function toolDefinitions(): Record<string, unknown>[] {
  return [
    {
      name: 'create_repo',
      description: 'Create a new repository for the authenticated user.',
      inputSchema: {
        type: 'object',
        properties: {
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
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_issue',
      description: 'Create an issue in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
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
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          state: { type: 'string', description: 'Issue state: open, closed, or all' },
        },
        required: ['owner', 'repo'],
      },
    },
    {
      name: 'create_pull_request',
      description: 'Create a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          title: { type: 'string', description: 'Pull request title' },
          head: { type: 'string', description: 'Head branch name' },
          base: { type: 'string', description: 'Base branch name' },
        },
        required: ['owner', 'repo', 'title', 'head', 'base'],
      },
    },
    {
      name: 'merge_pull_request',
      description: 'Merge a pull request in a repository.',
      inputSchema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner login' },
          repo: { type: 'string', description: 'Repository name' },
          pull_number: { type: 'integer', description: 'Pull request number' },
        },
        required: ['owner', 'repo', 'pull_number'],
      },
    },
  ];
}

function textResult(text: string, structured?: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { content: [{ type: 'text', text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

function errorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function repoSummary(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label })),
  };
}

function diffFiles(store: Store, repo: Repo, base: string, head: string): Pull['files'] {
  const baseFiles = store.branchFiles(repo, base);
  const headFiles = store.branchFiles(repo, head);
  const getContent = (oid: string): string => {
    const object = repo.objects.get(oid);
    return object === undefined ? '' : object.data.toString('utf8');
  };
  const files: Pull['files'] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    if (before === undefined && after !== undefined) {
      const additions = lineCount(getContent(after.oid));
      files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after === undefined) {
      const deletions = lineCount(getContent(before.oid));
      files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before !== undefined && after !== undefined) {
      const additions = lineCount(getContent(after.oid));
      const deletions = lineCount(getContent(before.oid));
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const argString = (key: string): string | undefined => {
    const value = args[key];
    return typeof value === 'string' ? value : undefined;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = argString('name');
      if (repoName === undefined || repoName === '') return errorResult('create_repo requires a non-empty "name" argument.');
      const existing = store.lookupRepo(store.viewer(), repoName);
      if (existing !== undefined) return errorResult(`Repository "${repoName}" already exists.`);
      const repo = store.createRepo(repoName, argString('description') ?? '', args['private'] === true);
      if (repo.owner === null) repo.owner = store.viewer();
      const summary = repoSummary(store, repo);
      return textResult(JSON.stringify(summary), summary);
    }
    case 'get_repo': {
      const owner = argString('owner');
      const repoName = argString('repo');
      if (owner === undefined || repoName === undefined) return errorResult('get_repo requires "owner" and "repo" arguments.');
      const repo = store.lookupRepo(owner, repoName);
      if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found.`);
      const summary = repoSummary(store, repo);
      return textResult(JSON.stringify(summary), summary);
    }
    case 'create_issue': {
      const owner = argString('owner');
      const repoName = argString('repo');
      const title = argString('title');
      if (owner === undefined || repoName === undefined || title === undefined) {
        return errorResult('create_issue requires "owner", "repo", and "title" arguments.');
      }
      const repo = store.lookupRepo(owner, repoName);
      if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found.`);
      const issue: Issue = {
        id: nextGlobalId(),
        number: repo.nextNumber,
        title,
        body: argString('body') ?? '',
        state: 'open',
        labels: [],
        seq: nextSeq(),
        comments: [],
      };
      repo.nextNumber += 1;
      repo.issues.push(issue);
      const summary = issueSummary(repo, issue);
      return textResult(JSON.stringify(summary), summary);
    }
    case 'list_issues': {
      const owner = argString('owner');
      const repoName = argString('repo');
      if (owner === undefined || repoName === undefined) return errorResult('list_issues requires "owner" and "repo" arguments.');
      const repo = store.lookupRepo(owner, repoName);
      if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found.`);
      const state = argString('state') ?? 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      const summaries = issues.map((issue) => issueSummary(repo, issue));
      return textResult(JSON.stringify(summaries), { issues: summaries });
    }
    case 'create_pull_request': {
      const owner = argString('owner');
      const repoName = argString('repo');
      const title = argString('title');
      const head = argString('head');
      const base = argString('base');
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return errorResult('create_pull_request requires "owner", "repo", "title", "head", and "base" arguments.');
      }
      const repo = store.lookupRepo(owner, repoName);
      if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found.`);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return errorResult(`Head branch "${head}" or base branch "${base}" does not exist.`);
      }
      const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
      if (existing !== undefined) return errorResult(`An open pull request from "${head}" to "${base}" already exists.`);
      const pull: Pull = {
        id: nextGlobalId(),
        number: repo.nextNumber,
        title,
        body: '',
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        files: diffFiles(store, repo, base, head),
        seq: nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.push(pull);
      const summary = { id: pull.id, number: pull.number, title: pull.title, state: pull.state, head: pull.head, base: pull.base };
      return textResult(JSON.stringify(summary), summary);
    }
    case 'merge_pull_request': {
      const owner = argString('owner');
      const repoName = argString('repo');
      const pullNumber = args['pull_number'];
      if (owner === undefined || repoName === undefined || typeof pullNumber !== 'number') {
        return errorResult('merge_pull_request requires "owner", "repo", and "pull_number" arguments.');
      }
      const repo = store.lookupRepo(owner, repoName);
      if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found.`);
      const pull = repo.pulls.find((entry) => entry.number === pullNumber);
      if (pull === undefined) return errorResult(`Pull request #${pullNumber} not found.`);
      if (pull.merged) return errorResult(`Pull request #${pullNumber} is already merged.`);
      const headFiles = store.branchFiles(repo, pull.head);
      const mergeSha = store.commitFiles(repo, pull.base, headFiles, `Merge pull request #${pull.number} from ${pull.head}`);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date((1735689600 + repo.commitSeq) * 1000).toISOString();
      pull.mergeCommitSha = mergeSha;
      pull.baseSha = mergeSha;
      const summary = { number: pull.number, merged: true, sha: mergeSha };
      return textResult(JSON.stringify(summary), summary);
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Handle one POST /mcp request. Auth is enforced by the caller (app.ts). */
export function handleMcp(store: Store, req: McpRequest): McpResponse {
  let request: RpcRequest;
  try {
    request = JSON.parse(req.body.toString('utf8')) as RpcRequest;
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error: request body is not valid JSON.') };
  }
  if (request === null || typeof request !== 'object' || typeof request.method !== 'string') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object with a method.') };
  }
  const id = request.id;
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params) ? request.params : {}) as Record<string, unknown>;

  switch (request.method) {
    case 'server/discover':
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: PROTOCOL_VERSIONS,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;
      const protocolVersion = offered !== undefined && PROTOCOL_VERSIONS.includes(offered) ? offered : PROTOCOL_VERSIONS[0];
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        }),
      };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      // A notification has no id and expects no response body.
      return { status: 202, body: null };
    case 'ping':
      return { status: 200, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, body: rpcResult(id, { tools: toolDefinitions() }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : undefined;
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      if (toolName === undefined) return { status: 200, body: rpcError(id, -32602, 'tools/call requires a tool name.') };
      const known = toolDefinitions().some((tool) => tool.name === toolName);
      if (!known) return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${toolName}`) };
      const required = (toolDefinitions().find((tool) => tool.name === toolName)?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
      const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcResult(id, errorResult(`Missing required arguments: ${missing.join(', ')}.`)) };
      }
      return { status: 200, body: rpcResult(id, callTool(store, toolName, args)) };
    }
    default:
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${request.method}`) };
  }
}
