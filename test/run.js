/**
 * Standalone smoke test for the host layer — runs against a scratch repo in
 * a temp dir with DSH_HOME redirected, no harness needed. `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-bw-test-'));
process.env.DSH_HOME = join(scratch, 'dshhome');
mkdirSync(process.env.DSH_HOME, { recursive: true });

const { detectRepo, resolveDefaultBranch, listBranches, diffStat, porcelainStatus, aheadBehind } = await import('../lib/git.js');
const { createWorktree, listManagedWorktrees, readMetadata, archiveWorktree, worktreesRoot } = await import('../lib/worktree.js');
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
});

await test('createWorktree checkout + duplicate copy branch', async () => {
  wt2 = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(wt2.branch, 'feature');
  const dup = await createWorktree({ repoRoot: repo, intent: 'checkout', branchName: 'feature' });
  assert.equal(dup.copiedFrom, 'feature');
  assert.match(dup.branch, /^feature-\d+$/);
  await archiveWorktree(dup.path, { force: true });
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

rmSync(scratch, { recursive: true, force: true });
console.log(results.join('\n'));
if (process.exitCode) {
  console.log('SMOKE: FAILED');
} else {
  console.log('SMOKE: ALL PASS');
}
