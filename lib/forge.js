/**
 * forge.js — GitHub integration through the user's `gh` CLI (paseo's model:
 * the forge CLI IS the transport; auth = whatever gh is logged into; we never
 * touch tokens). PR + checks arrive in ONE batched GraphQL query per target
 * with a 30 s TTL cache, in-flight dedupe and last-good fallback.
 */
import { execFile } from 'node:child_process';

const GH_TIMEOUT = 30000;
const PR_CACHE_TTL = 30000;
const AUTH_CACHE_TTL = 300000;

function execGh(args, opts = {}) {
  const { cwd, timeout = GH_TIMEOUT } = opts;
  return new Promise((resolve) => {
    execFile(
      'gh',
      args,
      {
        cwd,
        timeout,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
      },
      (error, stdout, stderr) => {
        if (!error) resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        else
          resolve({
            ok: false,
            code: typeof error.code === 'number' ? error.code : 1,
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? error.message),
          });
      },
    );
  });
}

let ghProbe = null;
/** Is the gh CLI installed? (cached forever per process) */
export async function ghAvailable() {
  if (ghProbe === null) {
    const r = await execGh(['--version'], { timeout: 10000 });
    ghProbe = r.ok;
  }
  return ghProbe;
}

let authState = { at: 0, ok: false };
/** Is gh authenticated? (cached 5 min) */
export async function ghAuthenticated() {
  if (!(await ghAvailable())) return false;
  if (Date.now() - authState.at < AUTH_CACHE_TTL) return authState.ok;
  const r = await execGh(['auth', 'status'], { timeout: 15000 });
  authState = { at: Date.now(), ok: r.ok };
  return authState.ok;
}

export function invalidateGhAuth() {
  authState = { at: 0, ok: false };
}

/**
 * Parse a GitHub owner/repo out of an origin URL (https or ssh).
 * @returns {{owner:string, repo:string, host:string}|null}
 */
export function parseGithubRemote(url) {
  if (!url) return null;
  const clean = url.trim().replace(/\.git$/, '');
  let m = /^https?:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(clean);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };
  m = /^(?:ssh:\/\/)?git@([^:]+):([^/]+)\/(.+)$/.exec(clean);
  if (m) return { host: m[1], owner: m[2], repo: m[3] };
  return null;
}

/* ------------------------------------------------------------------ */
/* PR status (batched GraphQL + TTL cache)                             */
/* ------------------------------------------------------------------ */

const prCache = new Map(); // key → {at, value}
const prInflight = new Map(); // key → Promise
const prLastGood = new Map(); // key → value

function prQuery(owner, repo, headRefName) {
  const q = (s) => JSON.stringify(String(s));
  return [
    `query {`,
    `repository(owner:${q(owner)},name:${q(repo)}){`,
    `pullRequests(headRefName:${q(headRefName)},first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{`,
    `number url title state isDraft baseRefName headRefName headRefOid mergedAt mergeable reviewDecision`,
    `statusCheckRollup{state contexts(first:50){nodes{__typename`,
    `... on CheckRun{name status conclusion detailsUrl}`,
    `... on StatusContext{context state targetUrl}`,
    `}}}}}}}`,
  ].join('');
}

function foldChecks(rollup) {
  if (!rollup) return { status: 'none', completed: 0, total: 0 };
  const nodes = rollup.contexts?.nodes ?? [];
  let total = 0;
  let completed = 0;
  let failure = false;
  let pending = false;
  for (const node of nodes) {
    if (!node) continue;
    total += 1;
    if (node.__typename === 'CheckRun') {
      if (node.status === 'COMPLETED') {
        completed += 1;
        if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(node.conclusion))
          failure = true;
      } else pending = true;
    } else {
      // StatusContext
      if (node.state === 'SUCCESS') completed += 1;
      else if (['FAILURE', 'ERROR'].includes(node.state)) {
        completed += 1;
        failure = true;
      } else pending = true;
    }
  }
  // rollup.state is GitHub's own fold: SUCCESS/FAILING/PENDING/EXPECTED...
  const state = rollup.state ?? '';
  if (failure || state === 'FAILING') return { status: 'failure', completed, total };
  if (pending || state === 'PENDING' || (total > 0 && completed < total)) return { status: 'pending', completed, total };
  if (total === 0) return { status: 'none', completed: 0, total: 0 };
  return { status: 'success', completed, total };
}

function normalizePr(node, headSha) {
  const merged = node.mergedAt !== null && node.mergedAt !== undefined;
  const state = merged || node.state === 'MERGED' ? 'merged' : node.state === 'OPEN' ? 'open' : 'closed';
  const numberMatch = /(?:pull|pulls|merge_requests)\/(\d+)/.exec(node.url ?? '');
  return {
    number: node.number ?? (numberMatch ? Number(numberMatch[1]) : null),
    url: node.url,
    title: node.title,
    state,
    isDraft: Boolean(node.isDraft),
    baseRefName: node.baseRefName,
    headRefName: node.headRefName,
    headRefOid: node.headRefOid,
    headShaMatches: headSha ? node.headRefOid === headSha : false,
    mergeable: node.mergeable ?? 'UNKNOWN',
    reviewDecision: node.reviewDecision ?? null,
    checks: foldChecks(node.statusCheckRollup),
  };
}

/**
 * PR + checks status for one (repo, headRef) target.
 * Candidate pick prefers exact head SHA match, then newest (paseo).
 * @returns {Promise<{pr:object|null, forgeAuth:'ok'|'cli_missing'|'unauthenticated'|'no_remote'|'error'}>}
 */
export async function prStatus(target) {
  const { owner, repo, headRef, headSha } = target;
  if (!owner || !repo || !headRef) return { pr: null, forgeAuth: 'no_remote' };
  if (!(await ghAvailable())) return { pr: null, forgeAuth: 'cli_missing' };
  if (!(await ghAuthenticated())) return { pr: null, forgeAuth: 'unauthenticated' };
  const key = `${owner}/${repo}@${headRef}:${headSha ?? ''}`;
  const cached = prCache.get(key);
  if (cached && Date.now() - cached.at < PR_CACHE_TTL) return cached.value;
  const inflight = prInflight.get(key);
  if (inflight) return inflight;
  const promise = (async () => {
    const r = await execGh(['api', 'graphql', '-f', `query=${prQuery(owner, repo, headRef)}`]);
    const parsed = tryParseGraphql(r.stdout);
    let value;
    if (parsed && parsed.nodes) value = pickPr(parsed.nodes, headSha);
    else if (parsed && parsed.forgeAuth === 'error') value = { pr: null, forgeAuth: 'error', error: parsed.error };
    else value = { pr: null, forgeAuth: 'error', error: (r.stderr || 'gh graphql failed').slice(0, 400) };
    prInflight.delete(key);
    if (value.forgeAuth === 'error') {
      const good = prLastGood.get(key);
      if (good) return good; // last-good fallback; do not cache the error
    }
    prCache.set(key, { at: Date.now(), value });
    if (value.pr) prLastGood.set(key, value);
    return value;
  })();
  prInflight.set(key, promise);
  return promise;
}

function tryParseGraphql(stdout) {
  try {
    const data = JSON.parse(stdout);
    const nodes = data?.data?.repository?.pullRequests?.nodes;
    if (!Array.isArray(nodes)) {
      if (data?.errors) return { pr: null, forgeAuth: 'error', error: String(data.errors[0]?.message ?? '').slice(0, 400) };
      return null;
    }
    return { nodes, forgeAuth: 'ok' };
  } catch {
    return null;
  }
}

/**
 * Batched PR status for many targets: ONE aliased GraphQL call (paseo batches
 * ≤25 per call). Returns Map<key, {pr, forgeAuth}>.
 */
export async function prStatusBatch(targets) {
  const out = new Map();
  if (targets.length === 0) return out;
  if (!(await ghAvailable())) {
    for (const t of targets) out.set(t.key, { pr: null, forgeAuth: 'cli_missing' });
    return out;
  }
  if (!(await ghAuthenticated())) {
    for (const t of targets) out.set(t.key, { pr: null, forgeAuth: 'unauthenticated' });
    return out;
  }
  const fresh = [];
  for (const t of targets) {
    const key = `${t.owner}/${t.repo}@${t.headRef}:${t.headSha ?? ''}`;
    t.cacheKey = key;
    const cached = prCache.get(key);
    if (cached && Date.now() - cached.at < PR_CACHE_TTL) out.set(t.key, cached.value);
    else fresh.push(t);
  }
  for (let i = 0; i < fresh.length; i += 20) {
    const chunk = fresh.slice(i, i + 20);
    const q = (s) => JSON.stringify(String(s));
    const parts = chunk.map(
      (t, idx) =>
        `t${idx}:repository(owner:${q(t.owner)},name:${q(t.repo)}){pullRequests(headRefName:${q(t.headRef)},first:10,orderBy:{field:CREATED_AT,direction:DESC}){nodes{number url title state isDraft baseRefName headRefName headRefOid mergedAt mergeable reviewDecision statusCheckRollup{state contexts(first:50){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}}}}}`,
    );
    const r = await execGh(['api', 'graphql', '-f', `query=query{${parts.join('')}}`], { timeout: 45000 });
    let data = null;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      /* partial below */
    }
    chunk.forEach((t, idx) => {
      const nodes = data?.data?.[`t${idx}`]?.pullRequests?.nodes;
      let value;
      if (Array.isArray(nodes)) {
        value = pickPr(nodes, t.headSha);
      } else {
        value = prLastGood.get(t.cacheKey) ?? { pr: null, forgeAuth: r.ok ? 'error' : 'error', error: (r.stderr || '').slice(0, 400) };
      }
      prCache.set(t.cacheKey, { at: Date.now(), value });
      if (value.pr) prLastGood.set(t.cacheKey, value);
      out.set(t.key, value);
    });
  }
  return out;
}

function pickPr(nodes, headSha) {
  if (!nodes || nodes.length === 0) return { pr: null, forgeAuth: 'ok' };
  const exact = headSha ? nodes.find((n) => n.headRefOid === headSha) : null;
  const node = exact ?? nodes[0];
  return { pr: normalizePr(node, headSha), forgeAuth: 'ok' };
}

/** Drop cached PR state whose key contains `part` (e.g. `owner/repo@branch`) after mutations. */
export function invalidatePr(part) {
  for (const key of [...prCache.keys()]) if (key.includes(part)) prCache.delete(key);
}

/* ------------------------------------------------------------------ */
/* issue / pull-request listing (the picker's data source)              */
/* ------------------------------------------------------------------ */

const LIST_CACHE_TTL = 30000;
const listCache = new Map(); // key → {at, value}

/**
 * One page of issues + pull requests for a repository (paseo's
 * searchIssuesAndPrs): both `gh` subcommands in parallel, merged newest-first.
 * The repo is implied by the process cwd, exactly like the `gh` CLI itself —
 * so a caller inside a worktree lists the same repository as its main
 * checkout, with no owner/repo plumbing.
 *
 * `--state` is deliberately NOT passed: gh's default (open) is the only set a
 * picker should offer, and a merged PR cannot be checked out anyway.
 *
 * @param {{cwd:string, query?:string, limit?:number}} opts
 * @returns {Promise<{items:object[], authState:'authenticated'|'cli_missing'|'unauthenticated'|'error'}>}
 */
export async function listForgeItems(opts) {
  const { cwd, query = '', limit = 20 } = opts;
  if (!(await ghAvailable())) return { items: [], authState: 'cli_missing' };
  if (!(await ghAuthenticated())) return { items: [], authState: 'unauthenticated' };
  const key = `${cwd}\u0000${query}\u0000${limit}`;
  const cached = listCache.get(key);
  if (cached && Date.now() - cached.at < LIST_CACHE_TTL) return cached.value;

  const fields = 'number,title,url,state,body,labels,updatedAt';
  const [pulls, issues] = await Promise.all([
    execGh(
      [
        'pr',
        'list',
        '--search',
        query,
        '--json',
        // `headRepositoryOwner` is not optional decoration: the PR checkout
        // path names a fork's local branch `<owner>/<headRef>` and must know
        // whether the head is cross-repository at all. Without it every fork
        // PR is indistinguishable from a same-repo one and gets checked out
        // under the wrong branch name with a bogus origin upstream.
        `${fields},baseRefName,headRefName,headRepositoryOwner,isCrossRepository`,
        '--limit',
        String(limit),
      ],
      { cwd },
    ),
    execGh(['issue', 'list', '--search', query, '--json', fields, '--limit', String(limit)], { cwd }),
  ]);

  // `gh` reports its own transport problems on stderr with a non-zero exit;
  // a JSON array on stdout is the only success shape.
  const parse = (result, kind) => {
    if (!result.ok) return { failed: true };
    try {
      const rows = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) return { failed: true };
      return {
        items: rows.map((row) => normalizeForgeItem(row, kind)),
      };
    } catch {
      return { failed: true };
    }
  };
  const pullResult = parse(pulls, 'change_request');
  const issueResult = parse(issues, 'issue');
  if (pullResult.failed && issueResult.failed) {
    const stderr = `${pulls.stderr} ${issues.stderr}`.toLowerCase();
    const authState = /auth|login|credential/.test(stderr) ? 'unauthenticated' : 'error';
    const value = { items: [], authState, error: (pulls.stderr || issues.stderr || '').trim().slice(0, 400) };
    listCache.set(key, { at: Date.now(), value });
    return value;
  }

  const items = [...(pullResult.items ?? []), ...(issueResult.items ?? [])];
  // newest first; a missing updatedAt sorts last (equal timestamps keep PRs
  // before issues, paseo's stable order)
  items.sort((a, b) => {
    const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
    const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
    if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
  const value = { items, authState: 'authenticated' };
  listCache.set(key, { at: Date.now(), value });
  return value;
}

/** Flatten one `gh --json` row into the picker's shape (labels → names). */
function normalizeForgeItem(row, kind) {
  const labels = Array.isArray(row.labels)
    ? row.labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean)
    : [];
  return {
    kind,
    number: row.number,
    title: row.title ?? '',
    url: row.url ?? '',
    state: typeof row.state === 'string' ? row.state.toLowerCase() : '',
    body: typeof row.body === 'string' ? row.body : null,
    labels,
    updatedAt: row.updatedAt ?? null,
    ...(kind === 'change_request'
      ? {
          baseRefName: row.baseRefName ?? null,
          headRefName: row.headRefName ?? null,
          // The fork's branch-owner login: what the checkout names a fork PR's
          // local branch after (`<owner>/<headRef>`), so a list row must carry
          // it exactly like the detail view does.
          headOwnerLogin: row.headRepositoryOwner?.login ?? null,
          // `isCrossRepository` is GitHub's own fork flag — more reliable than
          // comparing owners (an org-owned branch of the same repo is not a
          // fork, and a renamed owner must not flip the decision).
          fork: row.isCrossRepository === true,
        }
      : {}),
  };
}

/** Drop cached list pages for one cwd (after a mutation that changes them). */
export function invalidateForgeList(cwd) {
  for (const key of [...listCache.keys()]) if (cwd === undefined || key.startsWith(`${cwd}\u0000`)) listCache.delete(key);
}

/**
 * One issue or pull request in full, straight from `gh` — the reference
 * codec's data source. A pull request is tried first because the two share
 * one number sequence, so a bare number is ambiguous and `gh pr view` reports
 * a non-pull-request number as a plain failure; when both views fail the
 * caller's message carries what `gh` said last.
 *
 * @param {{cwd:string, number:number, kind?:'change_request'|'issue'}} opts
 * @returns {Promise<{ok:true,item:object}|{ok:false,authState:string,message:string}>}
 */
export async function pullRequestDetail(opts) {
  const { cwd, number, kind } = opts;
  if (!Number.isInteger(number) || number <= 0) return { ok: false, authState: 'error', message: 'number required' };
  if (!(await ghAvailable())) return { ok: false, authState: 'cli_missing', message: 'gh CLI not installed' };
  if (!(await ghAuthenticated())) return { ok: false, authState: 'unauthenticated', message: 'gh is not authenticated' };

  const fields = 'number,title,url,state,body,labels,updatedAt';
  const bodies = {
    change_request: [
      'pr',
      'view',
      String(number),
      '--json',
      `${fields},baseRefName,headRefName,headRepositoryOwner,isCrossRepository`,
    ],
    issue: ['issue', 'view', String(number), '--json', fields],
  };
  const order = kind === 'issue' ? ['issue'] : kind === 'change_request' ? ['change_request'] : ['change_request', 'issue'];
  let lastError = null;
  for (const candidate of order) {
    const r = await execGh(bodies[candidate], { cwd });
    if (!r.ok) {
      lastError = r.stderr.trim().slice(0, 400);
      continue;
    }
    try {
      const row = JSON.parse(r.stdout);
      if (row && typeof row.number === 'number') {
        return { ok: true, item: normalizeForgeItem(row, candidate) };
      }
      lastError = 'gh returned an unexpected payload';
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 400);
    }
  }
  return { ok: false, authState: 'error', message: lastError || `no issue or pull request #${number}` };
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

/** Create a PR; returns {ok, url} or {ok:false, message}. */
export async function createPullRequest({ owner, repo, base, head, title, body, draft = false }) {
  const args = ['pr', 'create', '--repo', `${owner}/${repo}`, '--base', base, '--head', head, '--title', title, '--body', body ?? ''];
  if (draft) args.push('--draft');
  const r = await execGh(args, { timeout: 60000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  const url = r.stdout.trim().split('\n').pop();
  return { ok: true, url };
}

/** Merge a PR: method merge|squash|rebase; auto enables auto-merge. */
export async function mergePullRequest({ owner, repo, number, method = 'squash', auto = false }) {
  const flag = method === 'merge' ? '--merge' : method === 'rebase' ? '--rebase' : '--squash';
  const args = ['pr', 'merge', String(number), '--repo', `${owner}/${repo}`, flag];
  if (auto) args.push('--auto');
  const r = await execGh(args, { timeout: 60000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}

export async function disableAutoMerge({ owner, repo, number }) {
  const r = await execGh(['pr', 'merge', String(number), '--repo', `${owner}/${repo}`, '--disable-auto'], {
    timeout: 30000,
  });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}
