/**
 * Standalone smoke test for the host layer — runs against a scratch repo in
 * a temp dir with DSH_HOME redirected, no harness needed. `npm test`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';

const scratch = mkdtempSync(join(tmpdir(), 'dsh-bw-test-'));
process.env.DSH_HOME = join(scratch, 'dshhome');
mkdirSync(process.env.DSH_HOME, { recursive: true });

const { detectRepo, resolveDefaultBranch, listBranches, diffStat, porcelainStatus, aheadBehind } = await import('../lib/git.js');
const { createWorktree, listManagedWorktrees, readMetadata, archiveWorktree, worktreesRoot } = await import('../lib/worktree.js');
const { createAutoNamer, validateBranchSlug, cleanBranchName, parseNamePayload } = await import('../lib/autoname.js');
const { computeDiff, commitDiff, resolveDiffRefs } = await import('../lib/diff.js');
const { commitAction, buildActionLadder, executeAction } = await import('../lib/actions.js');
const { createGitStateHub } = await import('../lib/state.js');
const { createApi, API_PREFIX } = await import('../lib/api.js');
const { listForgeItems, pullRequestDetail, invalidateGhAuth, invalidateForgeList, ghAvailable } = await import('../lib/forge.js');

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
  const out = {
    handlers,
    titles: [],
    warnings: [],
    get(name) {
      if (name === 'llm') {
        return {
          async *stream(options) {
            assert.equal(typeof options.provider, 'string');
            assert.equal(options.purpose, 'better-workspaces-branch-name');
            // The budget has to survive a reasoning prelude: a reasoning model
            // spends it on reasoning-delta before any text-delta exists
            // (ADR 0004 Amendment 6.A — 64 tokens silently produced no slug).
            assert.ok(options.maxTokens >= 256, `naming budget too small: ${options.maxTokens}`);
            // a string reply is the common case; an explicit chunk array lets a
            // test script the reasoning-only / truncated replies
            const script = streamText();
            if (Array.isArray(script)) {
              for (const chunk of script) yield chunk;
              return;
            }
            yield { type: 'text-delta', text: script };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        };
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'mock', model: 'mock-1' }) };
      if (name === 'sessionTitle') return { rename: (session, title) => out.titles.push(title) };
      return undefined;
    },
    on(event, fn) {
      handlers[event] = fn;
      return () => {};
    },
    logger: {
      info() {},
      warn(message) {
        out.warnings.push(String(message));
      },
    },
  };
  return out;
}

await test('branch divergence facts + exact-ref base (paseo picker parity)', async () => {
  // purpose-made branch pair so no existing branch (main is wt1's measure,
  // feature is checked out in wt2) is touched: divbr local is one empty
  // commit ahead of its own remote-tracking ref
  const sha0 = git(repo, 'rev-parse', 'main').trim();
  git(repo, 'update-ref', 'refs/remotes/origin/divbr', sha0);
  const tree = git(repo, 'rev-parse', 'main^{tree}').trim();
  const advanced = git(repo, 'commit-tree', tree, '-p', sha0, '-m', 'advance divbr').trim();
  git(repo, 'update-ref', 'refs/heads/divbr', advanced);

  const branches = await listBranches(repo);
  const divbr = branches.find((b) => b.name === 'divbr');
  assert.ok(divbr.hasLocal && divbr.hasRemote);
  assert.equal(divbr.localOid, advanced);
  assert.equal(divbr.remoteOid, sha0);
  assert.equal(divbr.localAhead, 1);
  assert.equal(divbr.localBehind, 0);

  const wt = await createWorktree({
    repoRoot: repo,
    intent: 'branch-off',
    slug: 'exact-base-0001',
    base: 'refs/remotes/origin/divbr',
    sourceTitle: '  My Source Workspace  ',
  });
  assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), sha0, 'cut from the exact remote ref');
  const meta = await readMetadata(wt.path);
  assert.equal(meta.baseRefName, 'divbr');
  assert.equal(meta.sourceWorkspaceTitle, 'My Source Workspace');
  await assert.rejects(
    createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'exact-base-bad', base: 'refs/heads/definitely-missing' }),
    /does not exist/,
  );
  await archiveWorktree(wt.path, { force: true });
});

await test('task diff = the worktree session history (paseo worktree-diff parity)', async () => {
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'task-mode-0001', base: 'main' });
  // committed change since the base…
  writeFileSync(join(wt.path, 'task-committed.txt'), 'one\n');
  git(wt.path, 'add', '-A');
  git(wt.path, '-c', 'user.email=t@t.example', '-c', 'user.name=t', 'commit', '-m', 'task commit');
  // …then uncommitted edits + an untracked file on top
  writeFileSync(join(wt.path, 'task-committed.txt'), 'one\ntwo\n');
  writeFileSync(join(wt.path, 'task-untracked.txt'), 'fresh\n');
  const result = await computeDiff(wt.path, { mode: 'task' });
  assert.ok(result.refs.label.startsWith('task:'));
  const paths = result.files.map((f) => f.path);
  assert.ok(paths.includes('task-committed.txt'), 'committed-then-edited file present');
  assert.ok(paths.includes('task-untracked.txt'), 'untracked file present');
  const committed = result.files.find((f) => f.path === 'task-committed.txt');
  assert.equal(committed.additions, 2, 'measured against the base, not HEAD');
  const refs = await resolveDiffRefs(wt.path, { mode: 'task' });
  const log = git(wt.path, 'log', '--oneline', `${refs.baseRef}..HEAD`).trim().split('\n');
  assert.equal(log.length, 1, 'commit pane range is base..HEAD');
  await assert.rejects(computeDiff(repo, { mode: 'task' }), /task-base-missing/);
  await archiveWorktree(wt.path, { force: true });
});

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
  assert.deepEqual(parseNamePayload('```json\n{"title":" 修复登录 ","branch":"fix-login"}\n```'), { title: '修复登录', branch: 'fix-login' });
  assert.deepEqual(parseNamePayload('prose without json'), { title: null, branch: 'prose' });
  assert.deepEqual(parseNamePayload('{"title":"","branch":"x-y"}'), { title: null, branch: 'x-y' });
});

await test('autoname: first-message rename end-to-end', async () => {
  let reply = JSON.stringify({ title: '修复登录 bug', branch: 'fix-login-bug' });
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
  assert.deepEqual(ctx.titles, ['修复登录 bug'], 'same LLM call names the session');

  // one-shot: a later message never renames again
  reply = 'something-else';
  await namer.attempt(session, 'second message');
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'fix-login-bug');
  await archiveWorktree(wt.path, { force: true });
});

await test('autoname: prose fallback keeps branch-only', async () => {
  const ctx = mockNamerCtx(() => 'plain-slug-only');
  const namer = createAutoNamer(ctx, null);
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'golden-vale-9090' });
  await namer.attempt({ id: 'sf', header: { cwd: wt.path } }, 'hello');
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'plain-slug-only');
  assert.deepEqual(ctx.titles, []);
  await archiveWorktree(wt.path, { force: true });
});

await test('autoname: a reasoning-only reply keeps the placeholder and says why', async () => {
  // the field failure of ADR 0004 Amendment 6.A: reasoning tokens outran the
  // output budget, so the reply carried no text at all
  const ctx = mockNamerCtx(() => [
    { type: 'reasoning-delta', text: 'thinking about the prompt' },
    { type: 'reasoning-delta', text: 'still thinking' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]);
  const namer = createAutoNamer(ctx, null);
  const wt = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'quiet-heron-7777' });
  await namer.attempt({ id: 's7', header: { cwd: wt.path } }, 'hi');
  assert.equal(git(wt.path, 'branch', '--show-current').trim(), 'quiet-heron-7777');
  assert.equal((await readMetadata(wt.path)).autoName.status, 'attempted');
  assert.deepEqual(ctx.titles, [], 'an empty reply never names the session');
  assert.ok(
    ctx.warnings.some((m) => m.includes('max-tokens') && m.includes('reasoning chunks')),
    `expected a diagnostic warning, saw ${JSON.stringify(ctx.warnings)}`,
  );
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

/* ---------------- PR checkout (the forge's refs/pull/<N>/head) ---------------- */

/** git that answers null instead of throwing — for expected-failure probes. */
function tryGit(cwd, ...args) {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
}

/** git that MUST fail: returns git's stderr (captured, so the log stays clean). */
function gitFailure(cwd, ...args) {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return String(error.stderr || error.message);
  }
  throw new Error(`expected git ${args.join(' ')} to fail`);
}

function cloneRepo(from, to) {
  return execFileSync('git', ['clone', '--quiet', from, to], {
    cwd: scratch,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const prRemote = join(scratch, 'pr-remote.git');
const prRepo = join(scratch, 'pr-clone');
const prForkRemote = join(scratch, 'pr-fork-remote.git');
const prForkRepo = join(scratch, 'pr-fork-clone');
mkdirSync(prRemote);
git(prRemote, 'init', '--bare', '-b', 'main');
cloneRepo(prRemote, prRepo);
git(prRepo, 'config', 'user.email', 'test@dsh.local');
git(prRepo, 'config', 'user.name', 'DSH Test');
writeFileSync(join(prRepo, 'base.txt'), 'base\n');
git(prRepo, 'add', '-A');
git(prRepo, 'commit', '-m', 'base commit');
git(prRepo, 'push', '--quiet', 'origin', 'main');

/**
 * One PR head that exists ONLY as refs/pull/<N>/head on the bare remote — the
 * real forge layout: the contributor's branch is deleted again, so nothing
 * else (no local branch, no origin branch) can supply the commit.
 */
function pushPrHead(number, branch, file, content) {
  git(prRepo, 'checkout', '--quiet', '-b', branch);
  writeFileSync(join(prRepo, file), content);
  git(prRepo, 'add', '-A');
  git(prRepo, 'commit', '-m', `${branch} commit`);
  const sha = git(prRepo, 'rev-parse', 'HEAD').trim();
  git(prRepo, 'push', '--quiet', 'origin', `HEAD:refs/pull/${number}/head`);
  git(prRepo, 'checkout', '--quiet', 'main');
  git(prRepo, 'branch', '-D', branch);
  assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`), null, 'head branch deleted again');
  return sha;
}

const prSameRepoHead = pushPrHead(12, 'pr-same-repo', 'pr.txt', 'from the pr\n');
const prForkHead = pushPrHead(9, 'dark-mode', 'dark.txt', 'dark mode\n');
const prPostHead = pushPrHead(21, 'pr-post', 'post.txt', 'from the http route\n');
const prLockedHead = pushPrHead(33, 'pr-locked', 'locked.txt', 'locked\n');

// a contributor's fork clone: origin is the fork (no refs/pull/*), the base
// repository — the one that does carry them — is `upstream`
mkdirSync(prForkRemote);
git(prForkRemote, 'init', '--bare', '-b', 'main');
git(prRepo, 'push', '--quiet', prForkRemote, 'main:main');
cloneRepo(prForkRemote, prForkRepo);
git(prForkRepo, 'remote', 'add', 'upstream', prRemote);

// local main diverges from origin/main so origin-first base resolution is observable
writeFileSync(join(prRepo, 'local-only.txt'), 'never pushed\n');
git(prRepo, 'add', '-A');
git(prRepo, 'commit', '-m', 'local main commit (never pushed)');
const prOriginMain = git(prRepo, 'rev-parse', 'refs/remotes/origin/main').trim();
assert.notEqual(git(prRepo, 'rev-parse', 'refs/heads/main').trim(), prOriginMain);

await test('pr-checkout: same-repo PR head via refs/pull/<N>/head + tracking ref', async () => {
  // only the forge ref carries this commit: no local branch, no origin branch
  assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  assert.equal(tryGit(prRepo, 'merge-base', '--is-ancestor', prSameRepoHead, 'main'), null, 'PR head is not on main');

  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: { number: 12, headRef: 'pr-same-repo', baseRef: 'main' },
    sourceTitle: 'PR 12',
  });
  try {
    assert.equal(wt.branch, 'pr-same-repo');
    assert.equal(wt.copiedFrom, null);
    assert.equal(wt.pullNumber, 12);
    assert.equal(wt.prHeadSha, prSameRepoHead);
    assert.equal(wt.upstream, 'origin/pr-same-repo');
    assert.equal(wt.baseRefName, 'main');
    assert.equal(wt.baseRef, prOriginMain, 'the base is origin/main, not the newer local main');
    // the worktree really holds the PR head, not the base
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
    assert.equal(readFileSync(join(wt.path, 'pr.txt'), 'utf8'), 'from the pr\n');
    // the universal ref landed in the throwaway ref…
    assert.equal(git(prRepo, 'rev-parse', 'refs/dsh-better-workspaces/pr/12/pr-same-repo').trim(), prSameRepoHead);
    // …and origin/<headRef> was materialized from that very SHA, so the
    // tracking ref resolves even though the branch was never pushed
    const seeded = tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo');
    assert.equal((seeded || '').trim(), prSameRepoHead, 'origin/<headRef> materialized from the fetched SHA');
    assert.equal(git(wt.path, 'rev-parse', '--abbrev-ref', '@{upstream}').trim(), 'origin/pr-same-repo');

    const meta = await readMetadata(wt.path);
    assert.equal(meta.intent, 'pr-checkout');
    assert.equal(meta.branch, 'pr-same-repo');
    assert.equal(meta.pullNumber, 12);
    assert.equal(meta.pullHeadRef, 'pr-same-repo');
    assert.equal(meta.prHeadSha, prSameRepoHead);
    assert.equal(meta.upstream, 'origin/pr-same-repo');
    assert.equal(meta.baseRefName, 'main');
    assert.equal(meta.baseRef, prOriginMain);
    assert.equal(meta.sourceWorkspaceTitle, 'PR 12');
    assert.equal('pullForkOwner' in meta, false);
    assert.equal('autoName' in meta, false, 'a PR checkout is never an auto-rename candidate');
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: a taken local branch name uniquifies (-1, -2)', async () => {
  // the first checkout left refs/heads/pr-same-repo behind (archive keeps branches)
  assert.ok(git(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/heads/pr-same-repo').trim());
  const pull = { number: 12, headRef: 'pr-same-repo', baseRef: 'main' };
  const wt = await createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull });
  const wt2 = await createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull });
  try {
    assert.equal(wt.branch, 'pr-same-repo-1');
    assert.equal(wt2.branch, 'pr-same-repo-2');
    for (const created of [wt, wt2]) {
      assert.equal(created.prHeadSha, prSameRepoHead);
      assert.equal(git(created.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
      assert.equal((await readMetadata(created.path)).pullHeadRef, 'pr-same-repo');
    }
  } finally {
    for (const created of [wt, wt2]) await archiveWorktree(created.path, { force: true });
  }
});

await test('pr-checkout: fork PR → owner-prefixed branch, no upstream', async () => {
  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: { number: 9, headRef: 'dark-mode', baseRef: 'main', forkOwner: 'alice' },
  });
  try {
    assert.equal(wt.branch, 'alice/dark-mode');
    assert.equal(wt.prHeadSha, prForkHead);
    assert.equal(wt.upstream, null);
    assert.equal(wt.baseRefName, 'main');
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prForkHead);
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/, 'a fork head must not track origin/dark-mode');
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 9);
    assert.equal(meta.pullHeadRef, 'dark-mode');
    assert.equal(meta.pullForkOwner, 'alice');
    assert.equal('upstream' in meta, false);
    assert.equal('autoName' in meta, false);
    // the head landed in the PR's own throwaway ref (named after the anchor)
    assert.equal(git(prRepo, 'rev-parse', 'refs/dsh-better-workspaces/pr/9/alice/dark-mode').trim(), prForkHead);
    // and nothing was synthesized as the BASE repo's origin/dark-mode
    assert.equal(tryGit(prRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/dark-mode'), null);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: origin is tried first, upstream is the fallback', async () => {
  // this clone's origin is the fork: it has no refs/pull/*, only upstream does
  assert.equal(tryGit(prForkRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  const wt = await createWorktree({
    repoRoot: prForkRepo,
    intent: 'pr-checkout',
    pull: { number: 12, headRef: 'pr-same-repo', baseRef: 'main' },
  });
  try {
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead, 'the head came from upstream');
    assert.equal(wt.prHeadSha, prSameRepoHead);
    assert.equal(wt.upstream, null, 'a head fetched from upstream never tracks origin');
    assert.equal(wt.baseRefName, 'main');
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 12);
    assert.equal(meta.pullHeadRef, 'pr-same-repo');
    assert.equal('upstream' in meta, false);
    assert.equal(tryGit(prForkRepo, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/pr-same-repo'), null);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: an unseedable tracking ref must not fake an upstream', async () => {
  // hold the loose-ref lock so `git update-ref refs/remotes/origin/<headRef>`
  // fails deterministically: the checkout must still succeed, but it must
  // report NO upstream instead of one that `@{upstream}` cannot resolve
  const lock = join(prRepo, '.git', 'refs', 'remotes', 'origin', 'pr-locked.lock');
  mkdirSync(join(prRepo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  writeFileSync(lock, '');
  let wt;
  try {
    wt = await createWorktree({
      repoRoot: prRepo,
      intent: 'pr-checkout',
      pull: { number: 33, headRef: 'pr-locked', baseRef: 'main' },
    });
  } finally {
    rmSync(lock, { force: true });
  }
  try {
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prLockedHead, 'creation is not blocked by the tracking failure');
    assert.equal(wt.prHeadSha, prLockedHead);
    assert.equal(wt.upstream, null);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.pullNumber, 33);
    assert.equal('upstream' in meta, false);
    assert.match(gitFailure(wt.path, 'rev-parse', '@{upstream}'), /no upstream configured/);
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('pr-checkout: guards + tolerant base', async () => {
  // a number the forge does not have: the message names every attempted remote
  // ref AND the reason git gave, not a generic "did not resolve"
  await assert.rejects(
    createWorktree({ repoRoot: prForkRepo, intent: 'pr-checkout', pull: { number: 999, headRef: 'nope', baseRef: 'main' } }),
    (error) => {
      assert.match(error.message, /#999/);
      assert.match(error.message, /origin refs\/pull\/999\/head/);
      assert.match(error.message, /upstream refs\/pull\/999\/head/);
      assert.match(error.message, /couldn't find remote ref refs\/pull\/999\/head/);
      return true;
    },
  );
  // headRef is what names the local branch: it is mandatory
  await assert.rejects(createWorktree({ repoRoot: prRepo, intent: 'pr-checkout', pull: { number: 12 } }), /pull\.headRef/);
  // no remote to fetch a pull request from at all
  await assert.rejects(
    createWorktree({ repoRoot: repo, intent: 'pr-checkout', pull: { number: 12, headRef: 'pr-same-repo' } }),
    /no origin\/upstream remote/,
  );
  // a base the forge cannot resolve still yields a worktree (tolerant resolution)
  const wt = await createWorktree({
    repoRoot: prRepo,
    intent: 'pr-checkout',
    pull: { number: 12, headRef: 'pr-same-repo', baseRef: 'no-such-base' },
  });
  try {
    assert.match(wt.branch, /^pr-same-repo-\d+$/);
    assert.equal(wt.baseRefName, 'no-such-base');
    assert.equal(wt.baseRef, 'no-such-base');
    assert.equal(git(wt.path, 'rev-parse', 'HEAD').trim(), prSameRepoHead);
    const meta = await readMetadata(wt.path);
    assert.equal(meta.baseRefName, 'no-such-base');
    assert.equal(meta.baseRef, 'no-such-base');
  } finally {
    await archiveWorktree(wt.path, { force: true });
  }
});

await test('api: POST /worktrees with pull → pr-checkout', async () => {
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {});
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const res = await fetch(`${base}/worktrees`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd: prRepo, pull: { number: 21, headRef: 'pr-post', baseRef: 'main' }, sourceTitle: 'PR 21' }),
    });
    const created = await res.json();
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.branch, 'pr-post');
    assert.equal(created.pullNumber, 21);
    assert.equal(created.prHeadSha, prPostHead);
    assert.equal(created.upstream, 'origin/pr-post');
    assert.equal(readFileSync(join(created.path, 'post.txt'), 'utf8'), 'from the http route\n');
    const meta = await readMetadata(created.path);
    assert.equal(meta.intent, 'pr-checkout');
    assert.equal(meta.pullNumber, 21);
    assert.equal(meta.pullHeadRef, 'pr-post');
    assert.equal(meta.prHeadSha, prPostHead);
    assert.equal(meta.sourceWorkspaceTitle, 'PR 21');
    await archiveWorktree(created.path, { force: true });
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

/* ---------------- HTTP layer ---------------- */
await test('api routes over real HTTP', async () => {
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {
    worktreeWorkspaces: async () => [{ workspaceId: 'ws-provider-x', path: '/tmp/provider-x' }],
  });
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

    // worktree-workspaces echoes the provider
    const wws = await get('/worktree-workspaces');
    assert.equal(wws.ok, true);
    assert.deepEqual(wws.items, [{ workspaceId: 'ws-provider-x', path: '/tmp/provider-x' }]);

    // task mode requires managed-worktree metadata
    const taskPlain = await get(`/diff?cwd=${encodeURIComponent(repo)}&mode=task`);
    assert.equal(taskPlain.ok, false);
    assert.equal(taskPlain.error, 'task-base-missing');
    const taskWt = await get(`/diff?cwd=${encodeURIComponent(wt1.path)}&mode=task`);
    assert.equal(taskWt.ok, true);
    assert.ok(taskWt.refs.label.startsWith('task:'));

    // POST /file: CAS write with guards
    const editable = join(repo, 'editable.txt');
    writeFileSync(editable, 'one\n');
    const baseSha = createHash('sha1').update(Buffer.from('one\n')).digest('hex');
    const casConflict = await post('/file', { cwd: repo, path: 'editable.txt', content: 'two\n', baseSha1: 'deadbeef' });
    assert.equal(casConflict.ok, false);
    assert.equal(casConflict.error, 'conflict');
    assert.equal(readFileSync(editable, 'utf8'), 'one\n', 'conflict must not write');
    const writeOk = await post('/file', { cwd: repo, path: 'editable.txt', content: 'two\n', baseSha1: baseSha });
    assert.equal(writeOk.ok, true);
    assert.equal(readFileSync(editable, 'utf8'), 'two\n');
    const writeEscape = await post('/file', { cwd: repo, path: '../escape.txt', content: 'x' });
    assert.equal(writeEscape.ok, false);
    assert.equal(writeEscape.error, 'path escapes workspace');
    const writeMissing = await post('/file', { cwd: repo, path: 'definitely-missing.txt', content: 'x' });
    assert.equal(writeMissing.ok, false);
    assert.equal(writeMissing.error, 'existing file required');
    const writeBinary = await post('/file', { cwd: repo, path: 'editable.txt', content: 'a\u0000b' });
    assert.equal(writeBinary.ok, false);
    assert.equal(writeBinary.error, 'binary content rejected');
    rmSync(editable, { force: true });

    // GET /file text carries sha1 for the editor CAS
    const shaFile = join(repo, 'sha-probe.txt');
    writeFileSync(shaFile, 'probe\n');
    const fileGet = await get(`/file?cwd=${encodeURIComponent(repo)}&path=sha-probe.txt`);
    assert.equal(fileGet.kind, 'text');
    assert.equal(fileGet.sha1, createHash('sha1').update(Buffer.from('probe\n')).digest('hex'));
    rmSync(shaFile, { force: true });

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

/* ---------------- forge: the gh CLI, /pulls + /pull ---------------- */

// `lib/forge.js` shells out to the real `gh`, so the CLI itself is the fixture:
// a fake executable EARLY in PATH whose JSON mirrors `gh --json` exactly
// (label objects included, so the flattening is provable). Every call is
// logged as "<cwd>\t<args>" so the tests can show what the host layer passed.
const fakeGHDir = join(scratch, 'fake-gh');
const fakeGHLog = join(fakeGHDir, 'gh.log');
const fakeGH = String.raw`#!/bin/sh
printf '%s\t%s\n' "$(pwd)" "$*" >> "$FAKE_GH_DIR/gh.log"

case "$1" in
  --version)
    echo "gh version 9.9.9-fake (dsh test)"
    exit 0
    ;;
esac

# the unauthenticated fixture: gh exists, but every command (auth status
# included) fails the way an expired login does
if [ "$FAKE_GH_UNAUTH" = "1" ]; then
  echo "gh: To get started with GitHub CLI, please run: gh auth login" >&2
  exit 1
fi

case "$1 $2" in
  "auth status")
    echo "github.com"
    echo "  Logged in to github.com account dsh-tester (oauth_token)"
    exit 0
    ;;
  "pr list")
    cat <<'JSON'
[
  {
    "number": 12,
    "title": "Fix the flaky login test",
    "url": "https://github.com/acme/widget/pull/12",
    "state": "OPEN",
    "body": "Closes #31",
    "labels": [{"name": "bug"}, {"name": "ready"}],
    "baseRefName": "main",
    "headRefName": "fix-login",
    "headRepositoryOwner": {"login": "acme"},
    "isCrossRepository": false,
    "updatedAt": "2024-05-02T10:00:00Z"
  },
  {
    "number": 9,
    "title": "Add dark mode",
    "url": "https://github.com/acme/widget/pull/9",
    "state": "MERGED",
    "body": "opened from a fork",
    "labels": [{"name": "ui"}],
    "baseRefName": "main",
    "headRefName": "dark-mode",
    "headRepositoryOwner": {"login": "alice-dev"},
    "isCrossRepository": true,
    "updatedAt": "2024-05-01T09:00:00Z"
  },
  {
    "number": 5,
    "title": "Refactor the parser",
    "url": "https://github.com/acme/widget/pull/5",
    "state": "CLOSED",
    "body": null,
    "labels": ["legacy-string"],
    "baseRefName": "develop",
    "headRefName": "parser",
    "headRepositoryOwner": {"login": "acme"},
    "isCrossRepository": false,
    "updatedAt": "2024-04-20T08:00:00Z"
  }
]
JSON
    exit 0
    ;;
  "issue list")
    cat <<'JSON'
[
  {
    "number": 31,
    "title": "Login page 500s on Safari",
    "url": "https://github.com/acme/widget/issues/31",
    "state": "OPEN",
    "body": "steps to reproduce",
    "labels": [{"name": "bug"}],
    "updatedAt": "2024-05-03T12:00:00Z"
  },
  {
    "number": 21,
    "title": "Add dark mode",
    "url": "https://github.com/acme/widget/issues/21",
    "state": "CLOSED",
    "body": "wishlist",
    "labels": [],
    "updatedAt": "2024-04-25T07:00:00Z"
  }
]
JSON
    exit 0
    ;;
esac

case "$1 $2 $3" in
  "pr view 12")
    cat <<'JSON'
{"number":12,"title":"Fix the flaky login test","url":"https://github.com/acme/widget/pull/12","state":"OPEN","body":"Closes #31","labels":[{"name":"bug"},{"name":"ready"}],"baseRefName":"main","headRefName":"fix-login","headRepositoryOwner":{"login":"acme"},"isCrossRepository":false,"updatedAt":"2024-05-02T10:00:00Z"}
JSON
    exit 0
    ;;
  "pr view 9")
    cat <<'JSON'
{"number":9,"title":"Add dark mode","url":"https://github.com/acme/widget/pull/9","state":"MERGED","body":"opened from a fork","labels":[{"name":"ui"}],"baseRefName":"main","headRefName":"dark-mode","headRepositoryOwner":{"login":"alice-dev"},"isCrossRepository":true,"updatedAt":"2024-05-01T09:00:00Z"}
JSON
    exit 0
    ;;
  "issue view 31")
    cat <<'JSON'
{"number":31,"title":"Login page 500s on Safari","url":"https://github.com/acme/widget/issues/31","state":"OPEN","body":"steps to reproduce","labels":[{"name":"bug"}],"updatedAt":"2024-05-03T12:00:00Z"}
JSON
    exit 0
    ;;
esac

# anything else: the non-zero exit a real gh uses for "nothing matched", so the
# host layer must fall back (pr view → issue view) instead of failing
echo "no pull requests or issues matched: $*" >&2
exit 1
`;
mkdirSync(fakeGHDir, { recursive: true });
writeFileSync(join(fakeGHDir, 'gh'), fakeGH, { mode: 0o755 });
process.env.FAKE_GH_DIR = fakeGHDir;
// before any real gh installation on this machine
process.env.PATH = `${fakeGHDir}:${process.env.PATH}`;

await test('forge: gh missing from PATH → cli_missing', async () => {
  // `ghAvailable` caches "installed" for the whole process, so the missing-gh
  // case gets its own module instance instead of poisoning the shared one
  const isolated = await import('../lib/forge.js?gh-missing');
  const emptyBin = join(scratch, 'empty-bin');
  mkdirSync(emptyBin, { recursive: true });
  const withFakeGH = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    assert.equal(await isolated.ghAvailable(), false);
    assert.deepEqual(await isolated.listForgeItems({ cwd: prRepo }), { items: [], authState: 'cli_missing' });
    assert.deepEqual(await isolated.pullRequestDetail({ cwd: prRepo, number: 12 }), {
      ok: false,
      authState: 'cli_missing',
      message: 'gh CLI not installed',
    });
  } finally {
    process.env.PATH = withFakeGH;
  }
});

await test('forge: auth states + gh JSON flattening (list + detail)', async () => {
  assert.equal(await ghAvailable(), true, 'the process-wide probe must find the fake gh');

  // gh exists but `gh auth status` fails
  process.env.FAKE_GH_UNAUTH = '1';
  invalidateGhAuth();
  assert.deepEqual(await listForgeItems({ cwd: prRepo }), { items: [], authState: 'unauthenticated' });
  assert.deepEqual(await pullRequestDetail({ cwd: prRepo, number: 12 }), {
    ok: false,
    authState: 'unauthenticated',
    message: 'gh is not authenticated',
  });
  delete process.env.FAKE_GH_UNAUTH;
  invalidateGhAuth();

  // both subcommands answer with JSON → issues + PRs merged newest-first
  invalidateForgeList();
  const listed = await listForgeItems({ cwd: prRepo });
  assert.equal(listed.authState, 'authenticated');
  assert.deepEqual(listed.items.map((i) => i.number), [31, 12, 9, 21, 5], 'merged and sorted by updatedAt');
  assert.deepEqual(listed.items.map((i) => i.kind), ['issue', 'change_request', 'change_request', 'issue', 'change_request']);
  assert.deepEqual(listed.items.find((i) => i.number === 12), {
    kind: 'change_request',
    number: 12,
    title: 'Fix the flaky login test',
    url: 'https://github.com/acme/widget/pull/12',
    state: 'open',
    body: 'Closes #31',
    labels: ['bug', 'ready'],
    updatedAt: '2024-05-02T10:00:00Z',
    baseRefName: 'main',
    headRefName: 'fix-login',
    headOwnerLogin: 'acme',
    fork: false,
  });
  assert.equal(listed.items.find((i) => i.number === 9).fork, true);
  /* A fork PR must carry its head owner in the LIST response too: the hero
     checks the fork's branch out as `<owner>/<headRef>`, so a list row without
     it would be handled as a same-repo PR and get an origin upstream. */
  assert.equal(
    listed.items.find((i) => i.number === 9).headOwnerLogin,
    'alice-dev',
    'a fork row names the owner its local branch will be prefixed with',
  );
  assert.equal(listed.items.find((i) => i.number === 9).state, 'merged', 'gh states are lowercased');
  assert.equal(listed.items.find((i) => i.number === 5).body, null);
  assert.deepEqual(listed.items.find((i) => i.number === 5).labels, ['legacy-string'], 'string labels still flatten');
  const issueRow = listed.items.find((i) => i.number === 31);
  assert.equal(issueRow.kind, 'issue');
  assert.deepEqual(issueRow.labels, ['bug']);
  assert.equal('baseRefName' in issueRow, false, 'issue rows carry no PR fields');
  assert.equal('headOwnerLogin' in issueRow, false, 'issue rows carry no PR fields');

  // one item in full: `gh pr view` for a PR…
  const detail = await pullRequestDetail({ cwd: prRepo, number: 12 });
  assert.equal(detail.ok, true);
  assert.equal(detail.item.kind, 'change_request');
  assert.equal(detail.item.state, 'open');
  assert.equal(detail.item.baseRefName, 'main');
  assert.equal(detail.item.headRefName, 'fix-login');
  assert.equal(detail.item.fork, false);
  assert.equal(detail.item.headOwnerLogin, 'acme');
  assert.deepEqual(detail.item.labels, ['bug', 'ready']);
  // …and the fork flavour of it
  const forkDetail = await pullRequestDetail({ cwd: prRepo, number: 9 });
  assert.equal(forkDetail.item.fork, true);
  assert.equal(forkDetail.item.headOwnerLogin, 'alice-dev');
  // an issue number: `gh pr view` fails, `gh issue view` is the fallback
  const asIssue = await pullRequestDetail({ cwd: prRepo, number: 31 });
  assert.equal(asIssue.ok, true);
  assert.equal(asIssue.item.kind, 'issue');
  assert.equal(asIssue.item.title, 'Login page 500s on Safari');
  const explicit = await pullRequestDetail({ cwd: prRepo, number: 12, kind: 'change_request' });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.item.number, 12);
  // a number neither subcommand knows
  const missing = await pullRequestDetail({ cwd: prRepo, number: 404 });
  assert.equal(missing.ok, false);
  assert.equal(missing.authState, 'error');
  assert.match(missing.message, /no pull requests or issues matched/);
});

await test('api: /pulls + /pull over real HTTP (fake gh)', async () => {
  rmSync(fakeGHLog, { force: true });
  const hub = createGitStateHub({ onChange: () => {} });
  const api = createApi(hub, {});
  const server = http.createServer((req, res) => api.route.handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${API_PREFIX}`;
  try {
    const get = async (path) => (await fetch(base + path)).json();

    // 400s
    const noCwd = await fetch(`${base}/pulls`);
    assert.equal(noCwd.status, 400);
    assert.equal((await noCwd.json()).error, 'cwd required');
    for (const number of ['abc', '0', '1.5', '']) {
      const bad = await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}&number=${number}`);
      assert.equal(bad.status, 400, `number=${JSON.stringify(number)}`);
      assert.equal((await bad.json()).error, 'number required');
    }
    assert.equal((await fetch(`${base}/pull?cwd=${encodeURIComponent(prRepo)}`)).status, 400);

    // a non-git cwd never reaches the forge
    assert.deepEqual(await get(`/pulls?cwd=${encodeURIComponent(scratch)}`), {
      ok: true,
      isGit: false,
      items: [],
      authState: 'no_remote',
    });
    const outsidePull = await get(`/pull?cwd=${encodeURIComponent(scratch)}&number=12`);
    assert.equal(outsidePull.ok, false);
    assert.equal(outsidePull.authState, 'no_remote');

    // the listing: merged issues+PRs, newest first, limit forwarded to gh
    const pulls = await get(`/pulls?cwd=${encodeURIComponent(prRepo)}&limit=7`);
    assert.equal(pulls.ok, true);
    assert.equal(pulls.isGit, true);
    assert.equal(pulls.authState, 'authenticated');
    assert.deepEqual(pulls.items.map((i) => i.number), [31, 12, 9, 21, 5]);
    const logLines = readFileSync(fakeGHLog, 'utf8').trim().split('\n');
    const prList = logLines.find((line) => line.includes('\tpr list '));
    assert.ok(prList, `gh pr list was invoked: ${logLines.join(' | ')}`);
    assert.ok(prList.startsWith(`${prRepo}\t`), `gh ran in the repo cwd: ${prList}`);
    assert.ok(prList.endsWith('--limit 7'), `the limit is forwarded: ${prList}`);
    /* The `--json` field list is a contract, not decoration: the fork's head
       owner is what names a fork PR's local branch, so dropping it from the
       request silently resolves the fork flag to null and checks the PR out
       under the wrong branch name with a bogus origin upstream. */
    assert.ok(prList.includes('headRepositoryOwner'), `the fork head owner is requested: ${prList}`);
    assert.ok(prList.includes('isCrossRepository'), `the fork flag is requested: ${prList}`);
    assert.ok(logLines.some((line) => line.includes('\tissue list ') && line.endsWith('--limit 7')));

    // one PR
    const pull = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=12`);
    assert.equal(pull.ok, true);
    assert.equal(pull.item.kind, 'change_request');
    assert.equal(pull.item.number, 12);
    assert.equal(pull.item.state, 'open');
    assert.equal(pull.item.baseRefName, 'main');
    assert.equal(pull.item.headRefName, 'fix-login');
    assert.equal(pull.item.fork, false);
    assert.deepEqual(pull.item.labels, ['bug', 'ready']);
    assert.equal(pull.item.url, 'https://github.com/acme/widget/pull/12');

    // a fork PR reports its origin
    const forkPull = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=9`);
    assert.equal(forkPull.ok, true);
    assert.equal(forkPull.item.fork, true);
    assert.equal(forkPull.item.headOwnerLogin, 'alice-dev');

    // an issue number: `gh pr view` fails first, `gh issue view` answers
    const issue = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=31`);
    assert.equal(issue.ok, true);
    assert.equal(issue.item.kind, 'issue');
    assert.equal(issue.item.title, 'Login page 500s on Safari');
    assert.equal('baseRefName' in issue.item, false);
    const issueExplicit = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=31&kind=issue`);
    assert.equal(issueExplicit.ok, true);
    assert.equal(issueExplicit.item.kind, 'issue');

    // a number gh does not know: a plain answer, never a 500
    const gone = await get(`/pull?cwd=${encodeURIComponent(prRepo)}&number=404`);
    assert.equal(gone.ok, false);
    assert.equal(gone.authState, 'error');
    assert.match(gone.message, /no pull requests or issues matched/);

    // the route reports the auth state it got from the forge
    process.env.FAKE_GH_UNAUTH = '1';
    invalidateGhAuth();
    const gate = await get(`/pulls?cwd=${encodeURIComponent(prRepo)}`);
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.items, []);
    assert.equal(gate.authState, 'unauthenticated');
    delete process.env.FAKE_GH_UNAUTH;
    invalidateGhAuth();
  } finally {
    api.dispose();
    server.close();
    await hub.dispose();
  }
});

await test('cleanup sweep: dry-run, guards, archive + workspace delete', async () => {
  const { createCleanup } = await import('../lib/cleanup.js');
  const deleted = [];
  const wsEntities = [];
  const registryMock = {
    list: () => wsEntities.slice(),
    delete: (id) => {
      deleted.push(id);
      return true;
    },
  };
  const sessionsMock = (cwds) => ({
    list: () => ({ ids: cwds.map((c, i) => `s${i}`), byId: Object.fromEntries(cwds.map((c, i) => [`s${i}`, { header: { cwd: c } }])) }),
  });
  const mockCtx = {
    get(name) {
      if (name === 'sessions') return sessionsMock([]);
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  };
  const cleanup = createCleanup(mockCtx);

  const wtClean = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'clean-sweep-0001' });
  const wtDirty = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'dirty-sweep-0002' });
  writeFileSync(join(wtDirty.path, 'junk.txt'), 'x\n');
  wsEntities.push(
    { path: wtClean.path, workspaceId: 'ws-clean-sweep-0001' },
    { path: wtDirty.path, workspaceId: 'ws-dirty-sweep-0002' },
  );

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
  wsEntities.push({ path: wtSession.path, workspaceId: 'ws-session-sweep-0003' });
  const guarded = await createCleanup({
    get(name) {
      if (name === 'sessions') return sessionsMock([wtSession.path]);
      if (name === 'workspaceRegistry') return registryMock;
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

await test('cleanup abandoned sweep: blank+old only', async () => {
  const { createCleanup } = await import('../lib/cleanup.js');
  const { patchMetadata } = await import('../lib/worktree.js');
  const deleted = [];
  const wsEntities = [];
  const registryMock = {
    list: () => wsEntities.slice(),
    delete: (id) => {
      deleted.push(id);
      return true;
    },
  };
  const mkCtx = (byId) => ({
    get(name) {
      if (name === 'sessions') return { list: () => ({ ids: Object.keys(byId), byId }) };
      if (name === 'workspaceRegistry') return registryMock;
      return undefined;
    },
  });
  const wtOld = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-old-0001' });
  const wtFresh = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-fresh-0002' });
  const wtBusy = await createWorktree({ repoRoot: repo, intent: 'branch-off', slug: 'abandon-busy-0003' });
  wsEntities.push(
    { path: wtOld.path, workspaceId: 'ws-abandon-old-0001' },
    { path: wtFresh.path, workspaceId: 'ws-abandon-fresh-0002' },
    { path: wtBusy.path, workspaceId: 'ws-abandon-busy-0003' },
  );
  const aged = Date.now() - 3600000;
  for (const target of [wtOld.path, wtBusy.path]) await patchMetadata(target, (m) => ({ ...m, createdAt: aged }));
  const byId = {
    s1: { header: { cwd: wtOld.path }, blank: true },
    s2: { header: { cwd: wtFresh.path }, blank: true },
    s3: { header: { cwd: wtBusy.path }, blank: false },
  };
  const report = await createCleanup(mkCtx(byId))({ abandoned: true, minAgeMs: 60000 });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.ok(report.archived.some((a) => a.path === wtOld.path), JSON.stringify(report));
  assert.ok(report.workspacesDeleted.includes('ws-abandon-old-0001'), JSON.stringify(report.workspacesDeleted));
  assert.ok(report.skipped.some((s) => s.path === wtFresh.path && s.reason === 'young'));
  assert.ok(report.skipped.some((s) => s.path === wtBusy.path && s.reason === 'session'));
  assert.ok(!existsSync(wtOld.path));
  assert.ok(existsSync(wtFresh.path) && existsSync(wtBusy.path));
  for (const target of [wtFresh.path, wtBusy.path]) await archiveWorktree(target, { force: true });
});

rmSync(scratch, { recursive: true, force: true });
console.log(results.join('\n'));
if (process.exitCode) {
  console.log('SMOKE: FAILED');
} else {
  console.log('SMOKE: ALL PASS');
}
