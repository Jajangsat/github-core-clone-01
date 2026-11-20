// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the shared store. Extra fields beyond the shapes the
// suite asserts are harmless; the statuses, the bodies it reads and the pagination Link
// headers are the contract.

import {
  EPOCH_SEC,
  lineCount,
  nextGlobalId,
  nextSeq,
  parseCommit,
  parseTree,
  treeFileMap,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}

function ok(body: unknown, headers?: Record<string, string>): RestResponse {
  return { status: 200, body, headers };
}

function created(body: unknown): RestResponse {
  return { status: 201, body };
}

function noContent(): RestResponse {
  return { status: 204 };
}

function notFound(message = 'Not Found'): RestResponse {
  return { status: 404, body: { message } };
}

function unprocessable(message: string): RestResponse {
  return { status: 422, body: { message } };
}

function conflict(message: string): RestResponse {
  return { status: 409, body: { message } };
}

function methodNotAllowed(message: string): RestResponse {
  return { status: 405, body: { message } };
}

function badRequest(message: string): RestResponse {
  return { status: 400, body: { message } };
}

const FIXED_DATE = '2025-01-01T00:00:00Z';

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer();
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer();
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: owner, id: 1000, type: 'User' },
    html_url: `https://example.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewer();
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1000, type: 'User' },
    html_url: `https://example.invalid/${owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) \+0000$/.exec(line.trim());
  if (match === null) return { name: line, email: '', date: FIXED_DATE };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

/** Paginate a list: the page's items plus a Link header when another page follows. */
function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const links: string[] = [];
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (page < totalPages) links.push(`<${baseUrl}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (page > 1) links.push(`<${baseUrl}${path}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { page: [...slice], headers };
}

/** The file map at a ref: a branch name, or a commit id directly. */
function filesAtRef(repo: Repo, ref: string | null): Map<string, { oid: string; mode: string }> | null {
  if (ref === null) ref = repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
  if (tip === undefined) return null;
  const object = repo.objects.get(tip);
  if (object === undefined || object.type !== 'commit') return null;
  return treeFileMap(parseCommit(object.data).tree, (oid) => repo.objects.get(oid));
}

/** The diff between two file maps, as pull-request file entries. */
function diffFiles(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  head: ReadonlyMap<string, { oid: string; mode: string }>,
  getContent: (oid: string) => string,
): Pull['files'] {
  const files: Pull['files'] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
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

export interface RestRequest {
  method: string;
  /** Path segments below /api/v3, URL-decoded, without empty segments. */
  segments: string[];
  query: URLSearchParams;
  /** The request's JSON body, or undefined when there is none. */
  body: unknown;
  /** The entry's own origin, for absolute Link headers. */
  baseUrl: string;
  /** The request path below /api/v3, with its leading slash, for Link headers. */
  path: string;
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const { method, segments } = req;
  const json = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

  // API root and meta.
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(
        {
          current_user_url: '/api/v3/user',
          rate_limit_url: '/api/v3/rate_limit',
          repository_url: '/api/v3/repos/{owner}/{repo}',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
    }
    return notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok({ installed_version: '1.0.0' });
    return notFound();
  }
  if (segments[0] === 'user') {
    if (segments.length === 1) {
      if (method === 'GET') {
        return ok({ login: store.viewer(), id: 1000, type: 'User', html_url: `https://example.invalid/${store.viewer()}` });
      }
      return notFound();
    }
    if (segments[1] === 'repos' && segments.length === 2) {
      if (method === 'GET') {
        const repos = store.allRepos();
        const { page, headers } = paginate(repos, req.query, req.baseUrl, req.path);
        return ok(page.map((repo) => repoJson(store, repo)), headers);
      }
      if (method === 'POST') {
        const body = json(req.body);
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return unprocessable('name is required');
        if (store.repos.has(name)) return unprocessable(`Repository '${name}' already exists`);
        const repo = store.createRepo(
          name,
          typeof body.description === 'string' ? body.description : '',
          body.private === true,
        );
        return created(repoJson(store, repo));
      }
      return notFound();
    }
    return notFound();
  }
  if (segments[0] !== 'repos' || segments.length < 3) return notFound();
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const repo = store.lookupRepo(owner, repoName);
  if (repo === undefined) return notFound();
  const rest = segments.slice(3);

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoJson(store, repo));
    if (method === 'PATCH') {
      const body = json(req.body);
      if (typeof body.description === 'string') repo.description = body.description;
      return ok(repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repoName);
      return noContent();
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) as string }, protected: false }));
      return ok(branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (sha === undefined) return notFound();
      return ok({ name: rest[1], commit: { sha }, protected: false });
    }
    return notFound();
  }

  // Git Data: refs.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const body = json(req.body);
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('invalid ref or sha');
      if (repo.refs.has(ref)) return unprocessable(`Reference '${ref}' already exists`);
      repo.refs.set(ref, sha);
      return created({ ref, object: { sha }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}` });
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const sha = repo.refs.get(`refs/heads/${rest[3]}`);
      if (sha === undefined) return notFound();
      return ok({ ref: `refs/heads/${rest[3]}`, object: { sha } });
    }
    return notFound();
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
    if (tip === undefined) return notFound();
    const commits = store.commitsFrom(repo, tip).map((oid) => {
      const object = repo.objects.get(oid) as { type: 'commit'; data: Buffer };
      const view = parseCommit(object.data);
      const author = parseIdentity(view.author);
      const committer = parseIdentity(view.committer);
      return {
        sha: oid,
        commit: {
          // Git stores the message with a trailing newline; the API surface shows it
          // without, as GitHub does.
          message: view.message.replace(/\n$/, ''),
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
          tree: { sha: view.tree },
        },
        author: { login: store.viewer() },
        committer: { login: store.viewer() },
        parents: view.parents.map((parent) => ({ sha: parent })),
      };
    });
    return ok(commits);
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    if (method === 'GET') {
      const ref = req.query.get('ref');
      const files = filesAtRef(repo, ref);
      if (files === null) return notFound();
      const treeOid = treeAtRef(repo, ref);
      if (treeOid === null) return notFound();
      if (filePath === '') {
        return ok(directoryListing(repo, treeOid, ''));
      }
      const direct = files.get(filePath);
      if (direct !== undefined) {
        const object = repo.objects.get(direct.oid);
        if (object === undefined) return notFound();
        return ok({
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: filePath.split('/').pop() as string,
          path: filePath,
          content: object.data.toString('base64'),
          sha: direct.oid,
        });
      }
      const prefix = `${filePath}/`;
      const children = [...files.keys()].filter((path) => path.startsWith(prefix));
      if (children.length === 0) return notFound();
      return ok(directoryListing(repo, treeOid, filePath));
    }
    if (method === 'PUT') {
      const body = json(req.body);
      const message = typeof body.message === 'string' ? body.message : 'update';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      if (contentB64 === '') return badRequest('content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return badRequest('content is not base64');
      }
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const branchExisted = repo.refs.has(`refs/heads/${branch}`);
      if (!branchExisted) {
        const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (defaultTip !== undefined) repo.refs.set(`refs/heads/${branch}`, defaultTip);
      }
      const files = store.branchFiles(repo, branch);
      const existing = files.get(filePath);
      const blobOid = store.putObject(repo, 'blob', content);
      // Updating a file on an existing branch needs its current sha; a PUT that creates
      // the branch (from the default tip) is a fresh create on that branch and needs none.
      if (existing !== undefined && branchExisted) {
        const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
        if (givenSha === undefined) return unprocessable('sha is required to update a file');
        if (givenSha.toLowerCase() !== existing.oid.toLowerCase()) return conflict('sha does not match the current file');
        if (blobOid === existing.oid) {
          const tip = repo.refs.get(`refs/heads/${branch}`) as string;
          return ok({
            content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
            commit: { sha: tip, message },
          });
        }
        files.set(filePath, { oid: blobOid, mode: existing.mode });
        const commitSha = store.commitFiles(repo, branch, files, message);
        return ok({
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha, message },
        });
      }
      files.set(filePath, { oid: blobOid, mode: existing?.mode ?? '100644' });
      const commitSha = store.commitFiles(repo, branch, files, message);
      return created({
        content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
        commit: { sha: commitSha, message },
      });
    }
    if (method === 'DELETE') {
      const body = json(req.body);
      const message = typeof body.message === 'string' ? body.message : 'delete';
      const files = store.branchFiles(repo, repo.defaultBranch);
      const existing = files.get(filePath);
      if (existing === undefined) return notFound();
      const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
      if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) return conflict('sha does not match the current file');
      files.delete(filePath);
      const commitSha = store.commitFiles(repo, repo.defaultBranch, files, message);
      return ok({ commit: { sha: commitSha, message }, content: null });
    }
    return notFound();
  }

  // Labels.
  if (rest[0] === 'labels' && rest.length === 1 && method === 'POST') {
    const body = json(req.body);
    const name = typeof body.name === 'string' ? body.name : '';
    if (name === '') return unprocessable('name is required');
    const color = typeof body.color === 'string' ? body.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) return created({ name: existing.name, color: existing.color });
    repo.labels.set(name, { name, color });
    return created({ name, color });
  }

  // Issues.
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = json(req.body);
        const title = typeof body.title === 'string' ? body.title : '';
        const labels = Array.isArray(body.labels) ? (body.labels as unknown[]) : [];
        const attached: { name: string; color: string }[] = [];
        for (const label of labels) {
          const name = typeof label === 'string' ? label : (label as { name?: unknown }).name;
          if (typeof name !== 'string') continue;
          const known = repo.labels.get(name);
          if (known === undefined) return unprocessable(`Label '${name}' does not exist`);
          attached.push(known);
        }
        const issue: Issue = {
          id: nextGlobalId(),
          number: repo.nextNumber,
          title,
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          labels: attached,
          seq: nextSeq(),
          comments: [],
        };
        repo.nextNumber += 1;
        repo.issues.push(issue);
        return created(issueJson(store, repo, issue));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        const sort = req.query.get('sort') ?? 'created';
        const direction = req.query.get('direction') ?? 'desc';
        let issues = [...repo.issues];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (sort === 'created') {
          issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, headers } = paginate(issues, req.query, req.baseUrl, req.path);
        return ok(page.map((issue) => issueJson(store, repo, issue)), headers);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') return ok(issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const body = json(req.body);
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        return ok(issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'POST') {
        const body = json(req.body);
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment = { id: nextGlobalId(), body: commentBody, seq: nextSeq() };
        issue.comments.push(comment);
        return created({
          id: comment.id,
          body: comment.body,
          user: { login: store.viewer(), id: 1000, type: 'User' },
          created_at: FIXED_DATE,
          updated_at: FIXED_DATE,
        });
      }
      if (method === 'GET') {
        return ok(
          issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            user: { login: store.viewer(), id: 1000, type: 'User' },
            created_at: FIXED_DATE,
            updated_at: FIXED_DATE,
          })),
        );
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = json(req.body);
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) return unprocessable('head or base branch does not exist');
        const duplicate = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
        if (duplicate !== undefined) return unprocessable('a pull request from this head already exists');
        const baseFiles = store.branchFiles(repo, base);
        const headFiles = store.branchFiles(repo, head);
        const getContent = (oid: string): string => {
          const object = repo.objects.get(oid);
          return object === undefined ? '' : object.data.toString('utf8');
        };
        const pull: Pull = {
          id: nextGlobalId(),
          number: repo.nextNumber,
          title: typeof body.title === 'string' ? body.title : '',
          body: typeof body.body === 'string' ? body.body : '',
          state: 'open',
          head,
          base,
          headSha,
          baseSha,
          merged: false,
          mergedAt: null,
          mergeCommitSha: null,
          files: diffFiles(baseFiles, headFiles, getContent),
          seq: nextSeq(),
        };
        repo.nextNumber += 1;
        repo.pulls.push(pull);
        return created(pullJson(store, repo, pull));
      }
      if (method === 'GET') {
        const state = req.query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.seq - a.seq);
        const { page, headers } = paginate(pulls, req.query, req.baseUrl, req.path);
        return ok(page.map((pull) => pullJson(store, repo, pull)), headers);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') return ok(pullJson(store, repo, pull));
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      return ok(
        pull.files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
        })),
      );
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      if (pull.merged) return methodNotAllowed('pull request is already merged');
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) return notFound();
      const base = store.mergeBase(repo, headTip, baseTip);
      const baseFiles = base === null ? new Map() : treeFileMapForCommit(repo, base);
      const baseTipFiles = store.branchFiles(repo, pull.base);
      const headTipFiles = store.branchFiles(repo, pull.head);
      if (mergeConflicts(baseFiles, baseTipFiles, headTipFiles)) {
        return methodNotAllowed('merge conflict');
      }
      const mergeSha = store.commitFiles(repo, pull.base, headTipFiles, `Merge pull request #${pull.number} from ${pull.head}`);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = new Date((EPOCH_SEC + repo.commitSeq) * 1000).toISOString();
      pull.mergeCommitSha = mergeSha;
      pull.baseSha = mergeSha;
      return ok({ sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}

/** The file map at a commit id. */
function treeFileMapForCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return treeFileMap(parseCommit(object.data).tree, (oid) => repo.objects.get(oid));
}

/** Whether the head and base both changed the same path differently since the merge-base. */
function mergeConflicts(
  baseFiles: ReadonlyMap<string, { oid: string; mode: string }>,
  currentBaseFiles: ReadonlyMap<string, { oid: string; mode: string }>,
  headFiles: ReadonlyMap<string, { oid: string; mode: string }>,
): boolean {
  const paths = new Set([...baseFiles.keys(), ...currentBaseFiles.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atHead = headFiles.get(path)?.oid;
    const atCurrent = currentBaseFiles.get(path)?.oid;
    const headChanged = atHead !== atBase;
    const baseChanged = atCurrent !== atBase;
    if (headChanged && baseChanged && atHead !== atCurrent) return true;
  }
  return false;
}

/** The root tree oid at a ref (a branch name, or a commit id directly). */
function treeAtRef(repo: Repo, ref: string | null): string | null {
  if (ref === null) ref = repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : undefined);
  if (tip === undefined) return null;
  const object = repo.objects.get(tip);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** A directory listing for `dirPath`, read from the tree objects themselves so directory
 *  entries carry their real tree sha. */
function directoryListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  let current = treeOid;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return [];
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (entry === undefined) return [];
      current = entry.oid;
    }
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data)
    .map((entry) => {
      const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
      if (entry.mode === '40000') {
        return { type: 'dir', name: entry.name, path, sha: entry.oid };
      }
      const blob = repo.objects.get(entry.oid);
      return { type: 'file', name: entry.name, path, sha: entry.oid, size: blob === undefined ? 0 : blob.data.length };
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
