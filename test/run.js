/**
 * Standalone smoke test for the host layer — runs against a scratch repo in
 * a temp dir with DSH_HOME redirected, no harness needed. `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-bw-test-'));
process.env.DSH_HOME = join(scratch, 'dshhome');
mkdirSync(process.env.DSH_HOME, { recursive: true });

const { detectRepo, resolveDefaultBranch, listBranches, diffStat, porcelainStatus, aheadBehind } = await import('../lib/git.js');
const { createWorktree, listManagedWorktrees, readMetadata, archiveWorktree, worktreesRoot } = await import('../lib/worktree.js');
const { createAutoNamer, validateBranchSlug, cleanBranchName } = await import('../lib/autoname.js');
const { computeDiff, commitDiff } = await import('../lib/diff.js');
const { commitAction, buildActionLadder, executeAction } = await import('../lib/actions.js');
const { createGitStateHub } = await import('../lib/state.js');
const { createApi, API_PREFIX } = await import('../lib/api.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

const results = [];
async function test(label, fn) {
  try {
    await fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

/* ---------------- fixture repo ---------------- */
const repo = join(scratch, 'main-repo');
mkdirSync(repo);
git(repo, 'init', '-b', 'main');
git(repo, 'config', 'user.email', 'test@dsh.local');
git(repo, 'config', 'user.name', 'DSH Test');
writeFileSync(join(repo, 'a.txt'), 'alpha\nbeta\n');
writeFileSync(join(repo, 'b.txt'), 'one\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-m', 'initial');
git(repo, 'branch', 'feature');

await test('detectRepo', async () => {
  const d = await detectRepo(repo);
  assert.equal(d.isGit, true);
  assert.equal(d.repoRoot, repo);
  assert.equal(d.isLinkedWorktree, false);
  const outside = await detectRepo(scratch);
  assert.equal(outside.isGit, false);
});

await test('branches + default branch', async () => {
  assert.equal(await resolveDefaultBranch(repo), 'main');
  const branches = await listBranches(repo);
  const names = branches.map((b) => b.name).sort();
  assert.deepEqual(names, ['feature', 'main']);
  assert.equal(branches.every((b) => b.hasLocal), true);
});

let wt1;
let wt2;
await test('createWorktree branch-off', async () => {
  wt1 = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'feature-x' });
  assert.ok(wt1.path.startsWith(worktreesRoot()), `path under worktrees root: ${wt1.path}`);
  assert.equal(wt1.branch, 'feature-x');
  const meta = await readMetadata(wt1.path);
  assert.equal(meta.baseRefName, 'main');
  assert.equal(meta.intent, 'branch-off');
  // explicit name → never an auto-rename candidate (ADR 0004)
  assert.equal(meta.autoName.status, 'ineligible');
});

await test('branch-off slug placeholder + autoName pending', async () => {
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'amber-otter-1234' });
  assert.equal(wt.branch, 'amber-otter-1234');
  const meta = await readMetadata(wt.path);
  assert.deepEqual(meta.autoName, { status: 'pending', placeholder: 'amber-otter-1234' });
  assert.equal(meta.baseRefName, 'main'); // default base
  // slugless branch-off falls back to a server-side mnemonic
  const wt2 = await createWorktree({ repoRoot: repo, intent: 'branch-off' });
  assert.match(wt2.branch, /^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.equal((await readMetadata(wt2.path)).autoName.status, 'pending');
});

await test('createWorktree checkout + duplicate copy branch', async () => {
  wt2 = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(wt2.branch, 'feature');
  const dup = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(dup.copiedFrom, 'feature');
  assert.match(dup.branch, /^feature-\d+$/);
  await archiveWorktree(dup.path, { force: true });
});

/* ---------------- first-message branch auto-rename (ADR 0004) ---------------- */

function mockNamerCtx(streamText) {
  const handlers = {};
  return {
    handlers,
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            assert.equal(typeof options.provider, 'string');
            assert.equal(options.purpose, 'better-workspaces-branch-name');
            yield { type: 'text-delta', text: streamText() };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) };
      return undefined;
    },
    on(event, fn) {
      handlers[event] = fn;
      return () => {};
    },
    logger: { info() {}, warn() {} },
  };
}

await test('autoname: slug rules + cleaner', async () => {
  assert.equal(validateBranchSlug('fix-login').valid, true);
  assert.equal(validateBranchSlug('fix/login-2').valid, true);
  assert.equal(validateBranchSlug('Fix-Login').valid, false);
  assert.equal(validateBranchSlug('-lead').valid, false);
  assert.equal(validateBranchSlug('trail-').valid, false);
  assert.equal(validateBranchSlug('a--b').valid, false);
  assert.equal(cleanBranchName('```git\nfix-login-bug\n```'), 'fix-login-bug');
  assert.equal(cleanBranchName('"Add Dark Mode"'), 'add');
  assert.equal(cleanBranchName('修复登录'), '');
  assert.equal(cleanBranchName('  FIX--Login_Bug  '), 'fix-login-bug');
});

await test('autoname: first-message rename end-to-end', async () => {
  let reply = 'fix-login-bug';
  const ctx = mockNamerCtx(() => reply);
  const namer = createAutoNamer(ctx, null);
  assert.equal(typeof ctx.handlers['session/event'], 'function');

  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'brave-falcon-abcd' });
  const session = { id: 's-test', header: { cwd: wt.path } };
  const event = {
    type: 'user/message',
    seq: 1,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修复登录 bug' }] },
  };

  ctx.handlers['session/event'](session, event);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'fix-login-bug');
  const meta = await readMetadata(wt.path);
  assert.equal(meta.branch, 'fix-login-bug');
  assert.equal(meta.autoName.status, 'renamed');
  assert.equal(meta.autoName.placeholder, 'brave-falcon-abcd');

  // one-shot: a later message never renames again
  reply = 'something-else';
  await namer.attempt(session, 'second message');
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'fix-login-bug');
  await archiveWorktree(wt.path, { force: true });
});

await test('autoname: guards (manual rename, invalid output, collision, subagent, non-worktree)', async () => {
  let reply = 'should-not-apply';
  const ctx = mockNamerCtx(() => reply);
  const namer = createAutoNamer(ctx, null);

  // manual rename before the first message → attempted, branch untouched
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'calm-heron-1111' });
  git(wt.path, 'branch', '-m', 'calm-heron-1111', 'my-manual-name');
  await namer.attempt({ id: 's2', header: { cwd: wt.path } }, 'hello');
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'my-manual-name');
  assert.equal((await readMetadata(wt.path)).autoName.status, 'attempted');

  // invalid model output (non-latin) → placeholder kept, one-shot consumed
  const wt2 = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'dusty-lynx-2222' });
  reply = '修复登录问题';
  await namer.attempt({ id: 's3', header: { cwd: wt2.path } }, 'hello');
  assert.equal(git(wt2.path, 'branch', '--show-current').trim(), 'dusty-lynx-2222');
  assert.equal((await readMetadata(wt2.path)).autoName.status, 'attempted');

  // collision with an existing branch → -2 suffix (paseo findAvailableBranchName)
  const wt3 = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'eager-otter-3333' });
  reply = 'feature';
  await namer.attempt({ id: 's4', header: { cwd: wt3.path } }, 'hello');
  assert.equal(git(wt3.path, 'branch', '--show-current').trim(), 'feature-2');

  // subagent sessions never trigger
  let called = false;
  const ctx2 = mockNamerCtx(() => {
    called = true;
    return 'nope';
  });
  createAutoNamer(ctx2, null);
  const wt4 = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'fierce-wolf-4444' });
  ctx2.handlers['session/event'](
    { id: 's5', header: { cwd: wt4.path, parentSession: 'parent-1' } },
    { type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(called, false);
  assert.equal(git(wt4.path, 'branch', '--show-current').trim(), 'fierce-wolf-4444');

  // plain repo cwd (outside worktrees root) → ignored even with pending-looking metadata
  await namer.attempt({ id: 's6', header: { cwd: repo } }, 'hello');
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'main');

  for (const p of [wt.path, wt2.path, wt3.path, wt4.path]) await archiveWorktree(p, { force: true });
});

await test('listManagedWorktrees', async () => {
  const list = await listManagedWorktrees(repo, wt1.path);
  assert.equal(list.items.length >= 3, true); // main + wt1 + wt2
  const main = list.items.find((i) => i.isMain);
  assert.ok(main);
  assert.equal(main.managed, false);
  const w1 = list.items.find((i) => i.path === wt1.path);
  assert.equal(w1.managed, true);
  assert.equal(w1.current, true);
  assert.equal(w1.baseRefName, 'main');
});

await test('diffStat + porcelain + computeDiff (uncommitted)', async () => {
  writeFileSync(join(wt1.path, 'a.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(wt1.path, 'new.txt'), 'fresh\nfile\n');
  const status = await porcelainStatus(wt1.path);
  assert.equal(status.dirty, true);
  const stat = await diffStat(wt1.path, 'main');
  assert.equal(stat.additions, 3); // 1 modified line + 2 untracked lines
  assert.equal(stat.deletions, 0);
  const diff = await computeDiff(wt1.path, { mode: 'uncommitted' });
  const paths = diff.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'new.txt']);
  const a = diff.files.find((f) => f.path === 'a.txt');
  assert.equal(a.status, 'modified');
  assert.equal(a.hunks.length, 1);
  const added = a.hunks[0].lines.filter((l) => l.type === 'add').map((l) => l.content);
  assert.deepEqual(added, ['gamma']);
  const n = diff.files.find((f) => f.path === 'new.txt');
  assert.equal(n.untracked, true);
  assert.equal(n.status, 'added');
});

await test('commitAction + aheadBehind + base diff + commitDiff', async () => {
  const r = await commitAction(wt1.path, { message: 'wip: gamma + new' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ab = await aheadBehind(wt1.path, 'main');
  assert.equal(ab.ahead, 1);
  assert.equal(ab.behind, 0);
  const diff = await computeDiff(wt1.path, { mode: 'base' });
  assert.equal(diff.files.length, 2);
  const sha = git(wt1.path, 'rev-parse', 'HEAD').trim();
  const cd = await commitDiff(wt1.path, sha);
  assert.equal(cd.files.length, 2);
  assert.equal(cd.isMerge, false);
});

await test('hub snapshotFor + fingerprint + invalidate', async () => {
  const emitted = [];
  const hub = createGitStateHub({ onChange: (s) => emitted.push(s) });
  try {
    const snap = await hub.snapshotFor(wt1.path);
    assert.equal(snap.isGit, true);
    assert.equal(snap.branch, 'feature-x');
    assert.equal(snap.managed, true);
    assert.equal(snap.baseRefName, 'main');
    assert.equal(snap.aheadBehind.ahead, 1);
    assert.equal(snap.dirty, false);
    assert.equal(snap.diffStat.additions, 3);
    assert.equal(snap.forgeAuth, 'no_remote');
    assert.equal(snap.pr, null);
    const neg = await hub.snapshotFor(scratch);
    assert.equal(neg.isGit, false);
    // mutate → invalidate → dirty snapshot emitted via SSE path
    writeFileSync(join(wt1.path, 'b.txt'), 'one\ntwo\n');
    hub.invalidate(wt1.path);
    await new Promise((r) => setTimeout(r, 800));
    const snap2 = await hub.snapshotFor(wt1.path);
    assert.equal(snap2.dirty, true);
    assert.ok(emitted.length >= 1, 'onChange emitted at least once');
    git(wt1.path, 'checkout', '--', 'b.txt');
  } finally {
    await hub.dispose();
  }
});

await test('action ladder (synthetic snapshots)', async () => {
  const clean = {
    branch: 'feature-x', dirty: false, remote: 'git@github.com:o/r.git', github: { owner: 'o', repo: 'r' },
    aheadBehind: { ahead: 2, behind: 1 }, upstream: { ref: 'refs/remotes/origin/feature-x', ahead: 1, behind: 1 },
    originDelta: null, pr: null, managed: true, baseRefName: 'main',
  };
  let ladder = buildActionLadder(clean);
  let ids = ladder.filter((e) => !e.disabled).map((e) => e.id);
  assert.equal(ids[0], 'pull'); // behind > 0 outranks push
  assert.ok(ids.includes('push'));
  assert.ok(ids.includes('createPr'));
  assert.equal(ladder.find((e) => e.id === 'commit').reasonKey, 'actions.commit.clean');
  // agentRunning disables mutations but not readOnly
  ladder = buildActionLadder(clean, { agentRunning: true });
  assert.equal(ladder.find((e) => e.id === 'push').disabled, true);
  assert.equal(ladder.find((e) => e.id === 'push').reasonKey, 'actions.disabled.agentRunning');
  assert.equal(ladder.find((e) => e.id === 'fetch').disabled, false);
  // open PR promotes mergePr
  const withPr = { ...clean, pr: { number: 7, state: 'open', url: 'https://x/7', isDraft: false, mergeable: 'MERGEABLE', checks: { status: 'success', completed: 3, total: 3 } } };
  ladder = buildActionLadder(withPr);
  ids = ladder.filter((e) => !e.disabled).map((e) => e.id);
  assert.equal(ids[0], 'pull');
  assert.ok(ids.includes('mergePr'));
  assert.ok(!ids.includes('createPr'));
});

await test('archive guards + archive', async () => {
  writeFileSync(join(wt2.path, 'dirty.txt'), 'x\n');
  const refused = await archiveWorktree(wt2.path, {});
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'unsafe');
  const forced = await archiveWorktree(wt2.path, { force: true });
  assert.equal(forced.ok, true);
  const list = await listManagedWorktrees(repo, repo);
  assert.equal(list.items.some((i) => i.path === wt2.path), false);
  const notManaged = await archiveWorktree(repo, { force: true });
  assert.equal(notManaged.ok, false);
  assert.equal(notManaged.reason, 'not-managed');
});

/* ---------------- HTTP layer ---------------- */
await test('api routes over real HTTP', async () => {
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub);
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const get = async (path) => (await fetch(base + path)).json();
    const post = async (path, body) =>
      (await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

    // 400 shapes must carry `message` so the client never shows a generic fallback
    const bad = await post('/worktrees', {});
    assert.equal(bad.ok, false);
    assert.equal(bad.message, 'cwd required');

    const detect = await get(`/detect?path=${encodeURIComponent(repo)}`);
    assert.equal(detect.ok, true);
    assert.equal(detect.isGit, true);
    assert.equal(detect.defaultBranch, 'main');

    const branches = await get(`/branches?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(branches.current, 'feature-x');
    assert.ok(branches.branches.length >= 3);

    const wts = await get(`/worktrees?cwd=${encodeURIComponent(wt1.path)}`);
    assert.ok(wts.items.some((i) => i.path === wt1.path && i.managed));

    const snap = await get(`/snapshot?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(snap.snapshot.branch, 'feature-x');

    const batch = await post('/snapshots', { cwds: [wt1.path, repo, scratch] });
    assert.equal(batch.byCwd[wt1.path].isGit, true);
    assert.equal(batch.byCwd[scratch].isGit, false);

    writeFileSync(join(wt1.path, 'http.txt'), 'via http\n');
    const diff = await get(`/diff?cwd=${encodeURIComponent(wt1.path)}&mode=uncommitted`);
    assert.ok(diff.files.some((f) => f.path === 'http.txt' && f.status === 'added'));

    const commits = await get(`/commits?cwd=${encodeURIComponent(wt1.path)}`);
    assert.equal(commits.commits.length, 1);
    assert.equal(commits.commits[0].subject, 'wip: gamma + new');
    assert.equal(commits.commits[0].unpushed, true); // no remote → unpushed

    const actions = await get(`/actions?cwd=${encodeURIComponent(wt1.path)}`);
    assert.ok(actions.ladder.some((e) => e.id === 'commit' && !e.disabled));

    const acted = await post('/action', { cwd: wt1.path, name: 'commit', params: { message: 'http commit' } });
    assert.equal(acted.ok, true, JSON.stringify(acted));

    const tree = await get(`/tree?cwd=${encodeURIComponent(wt1.path)}`);
    assert.ok(tree.entries.some((e) => e.name === 'a.txt'));
    assert.ok(!tree.entries.some((e) => e.name === '.git'));

    const file = await get(`/file?cwd=${encodeURIComponent(wt1.path)}&path=a.txt`);
    assert.equal(file.kind, 'text');
    assert.match(file.content, /gamma/);

    const escape = await get(`/file?cwd=${encodeURIComponent(wt1.path)}&path=../../etc/passwd`);
    assert.equal(escape.ok, false);

    // SSE: first payload contains the connected comment
    const controller = new AbortController();
    const events = await fetch(`${base}/events`, { signal: controller.signal });
    assert.equal(events.headers.get('content-type').includes('text/event-stream'), true);
    const reader = events.body.getReader();
    const chunk = await reader.read();
    const text = new TextDecoder().decode(chunk.value);
    assert.match(text, /:connected/);
    controller.abort();
    await reader.cancel().catch(() => {});
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

await test('cleanup sweep: dry-run, guards, archive + workspace delete', async () => {
  const { createCleanup } = await import('../lib/cleanup.js');
  const deleted = [];
  const registryMock = {
    resolveByPath: async (p) => ({ workspaceId: `ws-${p.split('/').pop()}` }),
    delete: async (req) => {
      deleted.push(req && req.workspaceId !== undefined ? req.workspaceId : req);
      return { ok: true };
    },
  };
  const sessionsMock = (cwds) => ({
    list: () => ({ ids: cwds.map((c, i) => `s${i}`), byId: Object.fromEntries(cwds.map((c, i) => [`s${i}`, { header: { cwd: c } }])) }),
  });
  const mockCtx = {
    get(name) {
      if (name === 'sessions') return sessionsMock([]);
      if (name === 'workspaces') return registryMock;
      return undefined;
    },
  };
  const cleanup = createCleanup(mockCtx);

  const wtClean = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'clean-sweep-0001' });
  const wtDirty = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'dirty-sweep-0002' });
  writeFileSync(join(wtDirty.path, 'junk.txt'), 'x\n');

  const dry = await cleanup({ dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.ok(dry.archived.some((a) => a.path === wtClean.path && a.dryRun === true));
  assert.ok(dry.skipped.some((s) => s.path === wtDirty.path && s.reason === 'dirty'));
  assert.ok(existsSync(wtClean.path), 'dry run must not remove anything');

  const live = await cleanup({});
  assert.ok(live.archived.some((a) => a.path === wtClean.path && !a.dryRun), JSON.stringify(live));
  assert.ok(live.skipped.some((s) => s.path === wtDirty.path));
  assert.ok(!existsSync(wtClean.path), 'archived worktree dir removed');
  assert.ok(deleted.includes('ws-clean-sweep-0001'), JSON.stringify(deleted));
  assert.ok(existsSync(wtDirty.path), 'dirty worktree untouched');
  // wt1 (committed + unpushed) must never be swept
  assert.ok(live.skipped.some((s) => s.path === wt1.path), 'committed worktree guarded');

  // live session cwd → skipped 'session'
  const wtSession = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'session-sweep-0003' });
  const guarded = await createCleanup({
    get(name) {
      if (name === 'sessions') return sessionsMock([wtSession.path]);
      if (name === 'workspaces') return registryMock;
      return undefined;
    },
  })({});
  assert.ok(guarded.skipped.some((s) => s.path === wtSession.path && s.reason === 'session'));
  assert.ok(existsSync(wtSession.path));

  // session guard unavailable without opt-in → refuse
  const refused = await createCleanup({ get: () => undefined })({});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /allowNoSessionGuard/);

  // archive guard fix: clean fresh worktree (no origin branch) archives non-force
  const plainArchive = await archiveWorktree(wtSession.path, {});
  assert.equal(plainArchive.ok, true, JSON.stringify(plainArchive));
  assert.ok(!existsSync(wtSession.path));

  await archiveWorktree(wtDirty.path, { force: true });
});

rmSync(scratch, { recursive: true, force: true });
console.log(results.join('\n'));
if (process.exitCode) {
  console.log('SMOKE: FAILED');
} else {
  console.log('SMOKE: ALL PASS');
}
