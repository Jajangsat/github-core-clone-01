// GraphQL v4: a small parser for the documents gh and github-mcp-server send, plus an
// executor over the shared store. Only the shapes those documents use are supported:
// queries (viewer, repository, node, __type), the five mutations, variables, inline
// enums and input objects, fragments (`... on Repository`), and batched operation arrays.

import {
  decodeGlobalId,
  encodeGlobalId,
  lineCount,
  nextGlobalId,
  nextSeq,
  parseCommit,
  treeFileMap,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer and parser (written for the documents this endpoint serves)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string };

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
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():[]!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
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
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'number', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

export interface Selection {
  kind: 'field' | 'fragment' | 'spread';
  name?: string;
  alias?: string;
  typeCondition?: string;
  args?: Record<string, Value>;
  selections?: Selection[];
}

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Record<string, Value | undefined>;
  selections: Selection[];
}

export interface Document {
  operations: Operation[];
  fragments: Record<string, Selection[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments: Record<string, Selection[]> = {};
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', variables: {}, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const kind = token.value as 'query' | 'mutation';
        this.next();
        let name: string | undefined;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = this.next().value;
        const variables: Record<string, Value | undefined> = {};
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.acceptPunct('=')) this.parseValue();
            variables[varName] = undefined;
          }
        }
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        const typeCondition = this.expectName();
        void typeCondition;
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.expectName();
      let alias: string | undefined;
      let name = first;
      if (this.acceptPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, Value> = {};
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue();
        }
      }
      let child: Selection[] | undefined;
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') child = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selections: child });
    }
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: Value[] = [];
      while (!this.acceptPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

export function parseGraphQL(source: string): Document {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------
// values and global ids
// ---------------------------------------------------------------------------

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

function argValue(field: Selection, name: string, variables: Record<string, unknown>): unknown {
  const raw = field.args?.[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, variables);
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId(`Repository:${repo.id}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId(`Issue:${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId(`PullRequest:${repo.id}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return encodeGlobalId(`IssueComment:${repo.id}:${issue.number}:${commentId}`);
}

// ---------------------------------------------------------------------------
// introspection tables
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'url',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// ---------------------------------------------------------------------------
// the executor
// ---------------------------------------------------------------------------

interface Context {
  store: Store;
  variables: Record<string, unknown>;
  document: Document;
  errors: Array<{ message: string }>;
}

function stateOf(issue: Issue): 'OPEN' | 'CLOSED' {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateOf(pull: Pull): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function findRepoById(store: Store, id: string): Repo | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  const parts = decoded.split(':');
  if (parts[0] !== 'Repository' || parts.length !== 2) return undefined;
  const wanted = Number(parts[1]);
  return store.allRepos().find((repo) => repo.id === wanted);
}

function findIssueById(store: Store, id: string): { repo: Repo; issue: Issue } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  const parts = decoded.split(':');
  if (parts[0] !== 'Issue' || parts.length !== 3) return undefined;
  const repo = store.allRepos().find((entry) => entry.id === Number(parts[1]));
  if (repo === undefined) return undefined;
  const issue = repo.issues.find((entry) => entry.number === Number(parts[2]));
  return issue === undefined ? undefined : { repo, issue };
}

function findPullById(store: Store, id: string): { repo: Repo; pull: Pull } | undefined {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return undefined;
  const parts = decoded.split(':');
  if (parts[0] !== 'PullRequest' || parts.length !== 3) return undefined;
  const repo = store.allRepos().find((entry) => entry.id === Number(parts[1]));
  if (repo === undefined) return undefined;
  const pull = repo.pulls.find((entry) => entry.number === Number(parts[2]));
  return pull === undefined ? undefined : { repo, pull };
}

function cursorFor(number: number): string {
  return encodeGlobalId(`cursor:${number}`);
}

function numberFromCursor(cursor: string): number | null {
  const decoded = decodeGlobalId(cursor);
  if (decoded === null) return null;
  const parts = decoded.split(':');
  if (parts[0] !== 'cursor' || parts.length !== 2) return null;
  const number = Number(parts[1]);
  return Number.isInteger(number) ? number : null;
}

function issueConnection(ctx: Context, repo: Repo, field: Selection): Record<string, unknown> {
  const first = argValue(field, 'first', ctx.variables);
  const after = argValue(field, 'after', ctx.variables);
  const states = argValue(field, 'states', ctx.variables);
  const orderBy = argValue(field, 'orderBy', ctx.variables);
  let issues = [...repo.issues];
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((state) => String(state)));
    issues = issues.filter((issue) => wanted.has(stateOf(issue)));
  }
  let direction = 'ASC';
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    direction = String((orderBy as Record<string, unknown>).direction ?? 'ASC');
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  if (typeof after === 'string' && after !== '') {
    const from = numberFromCursor(after);
    if (from !== null) {
      const index = issues.findIndex((issue) => issue.number === from);
      if (index >= 0) issues = issues.slice(index + 1);
    }
  }
  const total = issues.length;
  if (typeof first === 'number') issues = issues.slice(0, first);
  const nodesSelection = (field.selections ?? []).find((entry) => entry.kind === 'field' && entry.name === 'nodes');
  const nodes = issues.map((issue) => resolveIssue(ctx, repo, issue, nodesSelection?.selections ?? []));
  const endCursor = issues.length > 0 ? cursorFor(issues[issues.length - 1]?.number as number) : null;
  return {
    nodes,
    pageInfo: { hasNextPage: total > issues.length, endCursor },
    totalCount: total,
  };
}

function mergeableOf(ctx: Context, repo: Repo, pull: Pull): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = ctx.store.mergeBase(repo, headTip, baseTip);
  const baseFiles = base === null ? new Map() : treeFileMapForCommit(repo, base);
  const currentBase = ctx.store.branchFiles(repo, pull.base);
  const headFiles = ctx.store.branchFiles(repo, pull.head);
  const paths = new Set([...baseFiles.keys(), ...currentBase.keys(), ...headFiles.keys()]);
  for (const path of paths) {
    const atBase = baseFiles.get(path)?.oid;
    const atHead = headFiles.get(path)?.oid;
    const atCurrent = currentBase.get(path)?.oid;
    if (atHead !== atBase && atCurrent !== atBase && atHead !== atCurrent) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function treeFileMapForCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return treeFileMap(parseCommit(object.data).tree, (oid) => repo.objects.get(oid));
}

function resolveIssue(ctx: Context, repo: Repo, issue: Issue, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of expandSelections(ctx, selections)) {
    if (selection.kind !== 'field' || selection.name === undefined) continue;
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = issueGlobalId(repo, issue);
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'state':
        out[key] = stateOf(issue);
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'createdAt':
      case 'updatedAt':
        out[key] = '2025-01-01T00:00:00Z';
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Issue".` });
        break;
    }
  }
  return out;
}

function resolvePull(ctx: Context, repo: Repo, pull: Pull, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of expandSelections(ctx, selections)) {
    if (selection.kind !== 'field' || selection.name === undefined) continue;
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = pullGlobalId(repo, pull);
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullStateOf(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'headRefName':
        out[key] = pull.head;
        break;
      case 'baseRefName':
        out[key] = pull.base;
        break;
      case 'mergeable':
        out[key] = mergeableOf(ctx, repo, pull);
        break;
      case 'files': {
        const first = argValue(selection, 'first', ctx.variables);
        let files = pull.files.map((file) => ({ path: file.filename }));
        if (typeof first === 'number') files = files.slice(0, first);
        out[key] = { nodes: files };
        break;
      }
      case 'createdAt':
      case 'updatedAt':
        out[key] = '2025-01-01T00:00:00Z';
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "PullRequest".` });
        break;
    }
  }
  return out;
}

function resolveRepository(ctx: Context, repo: Repo, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const owner = repo.owner ?? ctx.store.viewer();
  for (const selection of expandSelections(ctx, selections)) {
    if (selection.kind !== 'field' || selection.name === undefined) continue;
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'id':
        out[key] = repoGlobalId(repo);
        break;
      case 'databaseId':
        out[key] = repo.id;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${owner}/${repo.name}`;
        break;
      case 'owner':
        out[key] = { login: owner };
        break;
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        out[key] = tip === undefined ? null : { name: repo.defaultBranch };
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'isPrivate':
        out[key] = repo.isPrivate;
        break;
      case 'issue': {
        const number = argValue(selection, 'number', ctx.variables);
        const issue = repo.issues.find((entry) => entry.number === number);
        out[key] = issue === undefined ? null : resolveIssue(ctx, repo, issue, selection.selections ?? []);
        break;
      }
      case 'issues':
        out[key] = issueConnection(ctx, repo, selection);
        break;
      case 'pullRequests': {
        const first = argValue(selection, 'first', ctx.variables);
        let pulls = repo.pulls.filter((pull) => pull.state === 'open');
        pulls.sort((a, b) => b.seq - a.seq);
        if (typeof first === 'number') pulls = pulls.slice(0, first);
        const nodesSelection = (selection.selections ?? []).find((entry) => entry.kind === 'field' && entry.name === 'nodes');
        out[key] = {
          nodes: pulls.map((pull) => resolvePull(ctx, repo, pull, nodesSelection?.selections ?? [])),
        };
        break;
      }
      case 'pullRequest': {
        const number = argValue(selection, 'number', ctx.variables);
        const pull = repo.pulls.find((entry) => entry.number === number);
        out[key] = pull === undefined ? null : resolvePull(ctx, repo, pull, selection.selections ?? []);
        break;
      }
      case 'createdAt':
      case 'updatedAt':
        out[key] = '2025-01-01T00:00:00Z';
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Repository".` });
        break;
    }
  }
  return out;
}

/** Expand fragment spreads into the field list they contribute. */
function expandSelections(ctx: Context, selections: Selection[]): Selection[] {
  const out: Selection[] = [];
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments[selection.name ?? ''];
      if (fragment !== undefined) out.push(...expandSelections(ctx, fragment));
      continue;
    }
    if (selection.kind === 'fragment') {
      out.push(...expandSelections(ctx, selection.selections ?? []));
      continue;
    }
    out.push(selection);
  }
  return out;
}

function resolveType(ctx: Context, name: string, selections: Selection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of expandSelections(ctx, selections)) {
    if (selection.kind !== 'field' || selection.name === undefined) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'name') out[key] = name;
    else if (selection.name === 'fields') out[key] = (TYPE_FIELDS[name] ?? []).map((field) => ({ name: field }));
    else if (selection.name === 'enumValues') {
      out[key] = name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ name: value })) : [];
    } else {
      ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "__Type".` });
    }
  }
  return out;
}

function executeOperation(ctx: Context, operation: Operation): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const selection of expandSelections(ctx, operation.selections)) {
    if (selection.kind !== 'field' || selection.name === undefined) continue;
    const key = selection.alias ?? selection.name;
    if (operation.kind === 'query') {
      switch (selection.name) {
        case 'viewer':
          data[key] = { login: ctx.store.viewer() };
          // Report an unknown subfield (for example noSuchFieldOnViewer) as an error.
          for (const sub of expandSelections(ctx, selection.selections ?? [])) {
            if (sub.kind === 'field' && sub.name !== 'login') {
              ctx.errors.push({ message: `Cannot query field "${sub.name}" on type "Viewer".` });
            }
          }
          break;
        case 'repository': {
          const owner = argValue(selection, 'owner', ctx.variables);
          const name = argValue(selection, 'name', ctx.variables);
          const repo =
            typeof owner === 'string' && typeof name === 'string' ? ctx.store.lookupRepo(owner, name) : undefined;
          data[key] = repo === undefined ? null : resolveRepository(ctx, repo, selection.selections ?? []);
          break;
        }
        case 'node': {
          const id = argValue(selection, 'id', ctx.variables);
          const repo = typeof id === 'string' ? findRepoById(ctx.store, id) : undefined;
          if (repo === undefined) {
            data[key] = null;
            break;
          }
          const owner = repo.owner ?? ctx.store.viewer();
          const node: Record<string, unknown> = { id: repoGlobalId(repo) };
          for (const sub of expandSelections(ctx, selection.selections ?? [])) {
            if (sub.kind === 'field') {
              if (sub.name === 'name') node[sub.alias ?? 'name'] = repo.name;
              else if (sub.name === 'nameWithOwner') node[sub.alias ?? 'nameWithOwner'] = `${owner}/${repo.name}`;
              else if (sub.name === 'id') node[sub.alias ?? 'id'] = repoGlobalId(repo);
            } else if (sub.kind === 'fragment') {
              for (const inner of expandSelections(ctx, sub.selections ?? [])) {
                if (inner.kind === 'field') {
                  if (inner.name === 'name') node[inner.alias ?? 'name'] = repo.name;
                  else if (inner.name === 'nameWithOwner') node[inner.alias ?? 'nameWithOwner'] = `${owner}/${repo.name}`;
                }
              }
            }
          }
          data[key] = node;
          break;
        }
        case '__type': {
          const name = argValue(selection, 'name', ctx.variables);
          data[key] = typeof name === 'string' ? resolveType(ctx, name, selection.selections ?? []) : null;
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Query".` });
          break;
      }
    } else {
      switch (selection.name) {
        case 'createIssue': {
          const input = argValue(selection, 'input', ctx.variables);
          const record = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
          const repo = typeof record.repositoryId === 'string' ? findRepoById(ctx.store, record.repositoryId) : undefined;
          if (repo === undefined) {
            ctx.errors.push({ message: 'createIssue: repository not found.' });
            data[key] = null;
            break;
          }
          const issue: Issue = {
            id: nextGlobalId(),
            number: repo.nextNumber,
            title: typeof record.title === 'string' ? record.title : '',
            body: typeof record.body === 'string' ? record.body : '',
            state: 'open',
            labels: [],
            seq: nextSeq(),
            comments: [],
          };
          repo.nextNumber += 1;
          repo.issues.push(issue);
          data[key] = {
            issue: resolveIssue(ctx, repo, issue, selection.selections?.[0]?.selections ?? []),
          };
          break;
        }
        case 'closeIssue': {
          const input = argValue(selection, 'input', ctx.variables);
          const record = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
          const found = typeof record.issueId === 'string' ? findIssueById(ctx.store, record.issueId) : undefined;
          if (found === undefined) {
            ctx.errors.push({ message: 'closeIssue: issue not found.' });
            data[key] = null;
            break;
          }
          found.issue.state = 'closed';
          data[key] = {
            issue: resolveIssue(ctx, found.repo, found.issue, selection.selections?.[0]?.selections ?? []),
          };
          break;
        }
        case 'createPullRequest': {
          const input = argValue(selection, 'input', ctx.variables);
          const record = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
          const repo = typeof record.repositoryId === 'string' ? findRepoById(ctx.store, record.repositoryId) : undefined;
          const head = typeof record.headRefName === 'string' ? record.headRefName : '';
          const base = typeof record.baseRefName === 'string' ? record.baseRefName : '';
          if (repo === undefined) {
            ctx.errors.push({ message: 'createPullRequest: repository not found.' });
            data[key] = null;
            break;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            ctx.errors.push({ message: 'createPullRequest: head or base branch does not exist.' });
            data[key] = null;
            break;
          }
          let pull = repo.pulls.find((entry) => entry.head === head && entry.base === base && entry.state === 'open');
          if (pull === undefined) {
            const baseFiles = ctx.store.branchFiles(repo, base);
            const headFiles = ctx.store.branchFiles(repo, head);
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
            pull = {
              id: nextGlobalId(),
              number: repo.nextNumber,
              title: typeof record.title === 'string' ? record.title : '',
              body: '',
              state: 'open',
              head,
              base,
              headSha,
              baseSha,
              merged: false,
              mergedAt: null,
              mergeCommitSha: null,
              files,
              seq: nextSeq(),
            };
            repo.nextNumber += 1;
            repo.pulls.push(pull);
          }
          data[key] = {
            pullRequest: resolvePull(ctx, repo, pull, selection.selections?.[0]?.selections ?? []),
          };
          break;
        }
        case 'mergePullRequest': {
          const input = argValue(selection, 'input', ctx.variables);
          const record = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
          const found = typeof record.pullRequestId === 'string' ? findPullById(ctx.store, record.pullRequestId) : undefined;
          if (found === undefined) {
            ctx.errors.push({ message: 'mergePullRequest: pull request not found.' });
            data[key] = null;
            break;
          }
          const { repo, pull } = found;
          if (!pull.merged) {
            const headFiles = ctx.store.branchFiles(repo, pull.head);
            const mergeSha = ctx.store.commitFiles(repo, pull.base, headFiles, `Merge pull request #${pull.number} from ${pull.head}`);
            pull.state = 'closed';
            pull.merged = true;
            pull.mergedAt = new Date((1735689600 + repo.commitSeq) * 1000).toISOString();
            pull.mergeCommitSha = mergeSha;
            pull.baseSha = mergeSha;
          }
          data[key] = {
            pullRequest: resolvePull(ctx, repo, pull, selection.selections?.[0]?.selections ?? []),
          };
          break;
        }
        case 'addComment': {
          const input = argValue(selection, 'input', ctx.variables);
          const record = (input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
          const found = typeof record.subjectId === 'string' ? findIssueById(ctx.store, record.subjectId) : undefined;
          if (found === undefined) {
            ctx.errors.push({ message: 'addComment: subject not found.' });
            data[key] = null;
            break;
          }
          const commentId = nextGlobalId();
          const body = typeof record.body === 'string' ? record.body : '';
          found.issue.comments.push({ id: commentId, body, seq: nextSeq() });
          data[key] = {
            commentEdge: {
              node: { id: commentGlobalId(found.repo, found.issue, commentId), body },
            },
          };
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${selection.name}" on type "Mutation".` });
          break;
      }
    }
  }
  return data;
}

/** Execute one GraphQL request body (a single operation, or a batch array). */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  const runOne = (entry: unknown): Record<string, unknown> => {
    const record = (entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}) as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables) ? record.variables : {}) as Record<string, unknown>;
    const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
    let document: Document;
    try {
      document = parseGraphQL(query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    const operation = operationName !== undefined ? document.operations.find((entry) => entry.name === operationName) ?? document.operations[0] : document.operations[0];
    if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
    const ctx: Context = { store, variables, document, errors: [] };
    const data = executeOperation(ctx, operation);
    const result: Record<string, unknown> = { data };
    if (ctx.errors.length > 0) result.errors = ctx.errors;
    return result;
  };
  if (Array.isArray(body)) return { status: 200, body: body.map(runOne) };
  return { status: 200, body: runOne(body) };
}
