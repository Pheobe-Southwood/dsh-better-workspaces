import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-bw-security-'));
process.env.DSH_HOME = join(sandbox, 'dsh-home');

const { API_PREFIX, createApi, firstForwarded, isLoopbackPeer, sameOrigin } = await import('../lib/api.js');
const { createWorkspaceAuthorizer } = await import('../lib/authorize.js');
const { archiveWorktree, createWorktree, metadataPathFor, repoWorktreesRoot, validateManagedWorktree } = await import('../lib/worktree.js');
const { createGitStateHub } = await import('../lib/state.js');
const { hostMutationCoordinator } = await import('../lib/mutation.js');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(path) {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-b', 'main');
  git(path, 'config', 'user.email', 'security@example.com');
  git(path, 'config', 'user.name', 'Security Test');
  writeFileSync(join(path, 'tracked.txt'), 'one\n');
  git(path, 'add', '.');
  git(path, 'commit', '-m', 'initial');
}

const repo = join(sandbox, 'registered-repo');
const outside = join(sandbox, 'outside-repo');
const plain = join(sandbox, 'registered-plain');
const external = join(sandbox, 'external.txt');
initRepo(repo);
initRepo(outside);
mkdirSync(plain);
writeFileSync(external, 'outside-secret\n');
const nested = join(repo, 'nested-workspace');
mkdirSync(nested);

let roots = [repo, nested, plain];
let snapshotsCalls = 0;
const hub = {
  async snapshotFor(cwd) {
    return { cwd, isGit: existsSync(join(cwd, '.git')) };
  },
  async snapshots(cwds) {
    snapshotsCalls += 1;
    return Object.fromEntries(cwds.map((cwd) => [cwd, { cwd, isGit: existsSync(join(cwd, '.git')) }]));
  },
  async invalidate() {},
  subscribe() {
    return () => {};
  },
};
const cleanup = async () => ({ ok: true, archived: [], skipped: [], errors: [] });
let observeMutation = null;
const observedMutations = {
  acquire(key, options) {
    observeMutation?.(key);
    return hostMutationCoordinator.acquire(key, options);
  },
  run(key, task, options) {
    observeMutation?.(key);
    return hostMutationCoordinator.run(key, task, options);
  },
};
const api = createApi(hub, {
  workspaceRoots: () => roots,
  cleanup,
  worktreeWorkspaces: async () => [],
  mutations: observedMutations,
});
const server = http.createServer((req, res) => api.route.handler(req, res));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}${API_PREFIX}`;

async function request(path, init) {
  const response = await fetch(base + path, init);
  const text = await response.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, status: response.status, headers: response.headers, body };
}

function jsonInit(body, headers = {}) {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Origin: origin, ...headers },
    body: JSON.stringify(body),
  };
}

try {
  // Every cwd/path selector is a registry capability lookup. One unauthorized
  // element also rejects a batch before the hub can observe any target.
  const unauthorizedGets = [
    `/detect?path=${encodeURIComponent(outside)}`,
    `/branches?cwd=${encodeURIComponent(outside)}`,
    `/pulls?cwd=${encodeURIComponent(outside)}`,
    `/pull?cwd=${encodeURIComponent(outside)}&number=1`,
    `/worktrees?cwd=${encodeURIComponent(outside)}`,
    `/snapshot?cwd=${encodeURIComponent(outside)}`,
    `/diff?cwd=${encodeURIComponent(outside)}`,
    `/commits?cwd=${encodeURIComponent(outside)}`,
    `/actions?cwd=${encodeURIComponent(outside)}`,
    `/file?cwd=${encodeURIComponent(outside)}&path=tracked.txt`,
    `/raw?cwd=${encodeURIComponent(outside)}&path=tracked.txt`,
  ];
  for (const path of unauthorizedGets) {
    const result = await request(path);
    assert.equal(result.status, 403, path);
  }
  const unauthorizedPosts = [
    ['/worktrees', { cwd: outside, intent: 'branch-off' }],
    ['/worktrees/archive', { path: outside, force: true }],
    ['/worktrees/cleanup', { cwd: outside }],
    ['/action', { cwd: outside, name: 'discard' }],
    ['/file', { cwd: outside, path: 'tracked.txt', content: 'clobbered\n', baseSha1: '0000000000000000000000000000000000000000' }],
  ];
  for (const [path, body] of unauthorizedPosts) {
    const result = await request(path, jsonInit(body));
    assert.equal(result.status, 403, path);
  }
  snapshotsCalls = 0;
  const atomic = await request('/snapshots', jsonInit({ cwds: [repo, outside] }));
  assert.equal(atomic.status, 403);
  assert.equal(snapshotsCalls, 0, 'an invalid batch must not call hub.snapshots');
  assert.equal(readFileSync(join(outside, 'tracked.txt'), 'utf8'), 'one\n');

  for (const selector of ['relative/path', join(sandbox, 'missing')]) {
    assert.equal((await request(`/detect?path=${encodeURIComponent(selector)}`)).status, 403);
  }
  const failedProvider = createWorkspaceAuthorizer({ workspaceRoots: () => { throw new Error('registry offline'); } });
  assert.equal((await failedProvider.authorize(repo)).ok, false, 'registry errors fail closed');
  const anchored = join(sandbox, 'anchored-workspace');
  const movedAnchor = join(sandbox, 'anchored-workspace-old');
  mkdirSync(anchored);
  const anchoredAuthorizer = createWorkspaceAuthorizer({ workspaceRoots: () => [anchored] });
  assert.equal((await anchoredAuthorizer.authorize(anchored)).ok, true);
  renameSync(anchored, movedAnchor);
  symlinkSync(outside, anchored);
  assert.equal((await anchoredAuthorizer.authorize(anchored)).ok, false, 'a registry path cannot be rebound by symlink');
  rmSync(anchored);
  renameSync(movedAnchor, anchored);

  // Registering a subdirectory authorizes its files, never its ancestor Git
  // repository or repository-wide mutations.
  writeFileSync(join(nested, 'note.txt'), 'nested\n');
  assert.equal((await request(`/file?cwd=${encodeURIComponent(nested)}&path=note.txt`)).status, 200);
  assert.equal((await request(`/detect?path=${encodeURIComponent(nested)}`)).status, 403);
  const nestedAction = await request('/action', jsonInit({ cwd: nested, name: 'discard' }));
  assert.equal(nestedAction.status, 403);
  assert.equal(readFileSync(join(repo, 'tracked.txt'), 'utf8'), 'one\n');

  // Lexical checks plus canonical target checks reject final and intermediate
  // symlink escapes for read, raw streaming and writes.
  symlinkSync(external, join(repo, 'leak.txt'));
  symlinkSync(dirname(external), join(repo, 'outside-dir'));
  for (const path of ['leak.txt', 'outside-dir/external.txt']) {
    const encoded = encodeURIComponent(path);
    assert.equal((await request(`/file?cwd=${encodeURIComponent(repo)}&path=${encoded}`)).status, 403);
    const raw = await request(`/raw?cwd=${encodeURIComponent(repo)}&path=${encoded}`);
    assert.equal(raw.status, 403);
    assert.notEqual(raw.body, 'outside-secret\n');
    assert.equal((await request('/file', jsonInit({ cwd: repo, path, content: 'clobbered\n', baseSha1: '0000000000000000000000000000000000000000' }))).status, 403);
  }
  assert.equal(readFileSync(external, 'utf8'), 'outside-secret\n');

  const gitConfigBefore = readFileSync(join(repo, '.git', 'config'), 'utf8');
  assert.equal((await request(`/file?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('.git/config')}`)).status, 403);
  assert.equal((await request('/file', jsonInit({ cwd: repo, path: '.git/config', content: 'hostile\n', baseSha1: createHash('sha1').update(gitConfigBefore).digest('hex') }))).status, 403);
  assert.equal(readFileSync(join(repo, '.git', 'config'), 'utf8'), gitConfigBefore);
  symlinkSync('.git/config', join(repo, 'git-config-alias'));
  assert.equal((await request(`/file?cwd=${encodeURIComponent(repo)}&path=git-config-alias`)).status, 403);
  assert.equal((await request(`/raw?cwd=${encodeURIComponent(repo)}&path=git-config-alias`)).status, 403);

  // Atomic replacement must break an in-workspace hard-link alias instead of
  // mutating the same inode outside the authorized root, and preserve mode.
  const outsideHard = join(sandbox, 'outside-hard.txt');
  const insideHard = join(repo, 'inside-hard.txt');
  writeFileSync(outsideHard, 'shared-before\n');
  chmodSync(outsideHard, 0o664);
  linkSync(outsideHard, insideHard);
  const hardSha = createHash('sha1').update('shared-before\n').digest('hex');
  const savedHard = await request('/file', jsonInit({ cwd: repo, path: 'inside-hard.txt', content: 'inside-after\n', baseSha1: hardSha }));
  if (savedHard.status === 200) {
    assert.equal(readFileSync(insideHard, 'utf8'), 'inside-after\n');
    assert.equal(readFileSync(outsideHard, 'utf8'), 'shared-before\n');
    assert.equal(statSync(insideHard).mode & 0o777, 0o664);

    // Same-base saves are serialized at the commit boundary: exactly one wins,
    // and the winner's bytes must be the bytes left on disk.
    const concurrentBase = createHash('sha1').update('inside-after\n').digest('hex');
    const concurrentContents = ['writer-a\n', 'writer-b\n', 'writer-c\n'];
    const concurrentSaves = await Promise.all(concurrentContents.map((content) =>
      request('/file', jsonInit({ cwd: repo, path: 'inside-hard.txt', content, baseSha1: concurrentBase }))));
    const winners = concurrentSaves.map((response, index) => ({ response, index })).filter(({ response }) => response.status === 200);
    assert.equal(winners.length, 1, JSON.stringify(concurrentSaves.map((response) => response.body)));
    assert.equal(concurrentSaves.filter((response) => response.status === 409).length, 2);
    assert.equal(readFileSync(insideHard, 'utf8'), concurrentContents[winners[0].index]);
  } else {
    assert.equal(savedHard.status, 503, JSON.stringify(savedHard.body));
    assert.match(savedHard.body?.message || '', /atomic file exchange unavailable/);
    assert.equal(readFileSync(insideHard, 'utf8'), 'shared-before\n', 'unsupported exchange fails before modifying either inode');
    assert.equal(readFileSync(outsideHard, 'utf8'), 'shared-before\n');
    assert.equal(readdirSync(repo).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false,
      'fail-closed save removes its owned temporary file before responding');
  }

  writeFileSync(join(repo, 'unsafe.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const svg = await request(`/raw?cwd=${encodeURIComponent(repo)}&path=unsafe.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  assert.match(svg.headers.get('content-security-policy') || '', /sandbox/);
  assert.equal((await request(`/raw?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent('.')}`)).status, 415);

  // Aborting raw responses must destroy the pipeline source and release its fd.
  writeFileSync(join(repo, 'large.png'), Buffer.alloc(4 * 1024 * 1024, 1));
  const fdBefore = readdirSync('/proc/self/fd').length;
  for (let index = 0; index < 20; index += 1) {
    await new Promise((resolveAbort, rejectAbort) => {
      const req = http.get(`${base}/raw?cwd=${encodeURIComponent(repo)}&path=large.png`, (response) => {
        response.once('data', () => {
          response.destroy();
          resolveAbort();
        });
      });
      req.once('error', (error) => {
        if (error?.code === 'ECONNRESET') resolveAbort();
        else rejectAbort(error);
      });
    });
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.ok(readdirSync('/proc/self/fd').length <= fdBefore + 3, 'aborted raw streams release file descriptors');

  // All POSTs are JSON-only and same-origin before any mutation/body dispatch.
  assert.equal((await request('/snapshots', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await request('/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/jsonp', Origin: origin }, body: '{}',
  })).status, 415);
  assert.equal((await request('/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })).status, 403);
  assert.equal((await request('/snapshots', jsonInit({}, { Origin: 'https://evil.example' }))).status, 403);
  assert.equal((await request('/snapshots', jsonInit({}, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);

  // A TLS-terminating tunnel (Cloudflare Tunnel et al.) talks plain HTTP to
  // this server, so the browser-visible scheme can only come from a loopback
  // proxy's X-Forwarded-Proto. Direct/remote callers keep the strict socket
  // check, and the host must still match.
  const tunnelOrigin = `https://127.0.0.1:${server.address().port}`;
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: tunnelOrigin,
  }))).status, 403, 'an https Origin without a forwarded header stays rejected');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: tunnelOrigin, 'X-Forwarded-Proto': 'https',
  }))).status, 200, 'a loopback proxy may vouch for the terminating scheme');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: tunnelOrigin, 'X-Forwarded-Proto': 'https, http',
  }))).status, 200, 'the first forwarded protocol entry is the client-facing one');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https',
  }))).status, 403, 'a forwarded scheme never bypasses the host comparison');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: tunnelOrigin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example',
  }))).status, 403, 'a forwarded host must match the Origin host');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: 'https://evil.example', 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'evil.example',
  }))).status, 200, 'a loopback proxy that rewrites Host may vouch for the browser-visible host too');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: 'https://tunnel.example', 'X-Forwarded-Proto': 'https',
  }))).status, 403, 'a proxy-rewritten Host without a forwarded host stays rejected');
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo] }, {
    Origin: `http://127.0.0.1:${server.address().port}`, 'X-Forwarded-Proto': 'https',
  }))).status, 200, 'forwarded headers never break an already-valid direct same-origin request');

  // Unit matrix: only loopback peers inherit the forwarded-header trust.
  const forged = {
    headers: { origin: 'https://evil.example', host: 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' },
  };
  for (const remoteAddress of ['203.0.113.9', '10.1.2.3', '192.168.1.5', undefined, '::2']) {
    assert.equal(sameOrigin({ ...forged, socket: { remoteAddress } }), false,
      `non-loopback peer ${String(remoteAddress)} cannot vouch for forwarded headers`);
  }
  for (const remoteAddress of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackPeer({ remoteAddress }), true, `${remoteAddress} is a loopback peer`);
    assert.equal(sameOrigin({ ...forged, socket: { remoteAddress } }), true,
      `loopback peer ${remoteAddress} vouches for self-consistent forwarded headers`);
    assert.equal(sameOrigin({
      headers: { ...forged.headers, 'x-forwarded-host': 'other.example' },
      socket: { remoteAddress },
    }), false, `loopback peer ${remoteAddress} still needs the forwarded host to match`);
  }
  assert.equal(isLoopbackPeer({ remoteAddress: '128.0.0.1' }), false, '127/8 must not be prefix-matched loosely');
  assert.equal(isLoopbackPeer({}), false, 'a socket without a remote address is untrusted');
  assert.equal(firstForwarded('  HTTPS , http '), 'https', 'forwarded values are trimmed and lowercased');
  assert.equal(firstForwarded(''), null, 'an empty forwarded value carries no context');
  assert.equal(firstForwarded(undefined), null, 'a missing forwarded value carries no context');
  assert.equal(sameOrigin({ headers: { host: 'evil.example', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } }), false,
    'a missing Origin is rejected even behind a loopback proxy');
  assert.equal(sameOrigin({ headers: { origin: 'null', host: 'evil.example', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } }), false,
    'an opaque Origin is rejected even behind a loopback proxy');
  assert.equal(sameOrigin({
    headers: { origin: 'https://evil.example', host: 'evil.example' },
    socket: { remoteAddress: '127.0.0.1' },
  }), false, 'a loopback peer without any forwarded header keeps the strict socket check');

  assert.equal((await request('/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{',
  })).status, 400);
  assert.equal((await request('/snapshots', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '[]',
  })).status, 400);
  assert.equal((await request('/snapshots', jsonInit({ padding: 'x'.repeat(1024 * 1024 + 1) }))).status, 413);
  assert.equal((await request('/snapshots', jsonInit({ cwds: [repo, plain] }))).status, 200);
  assert.equal((await request('/action', jsonInit({ cwd: repo, name: 'commit', params: {} }))).status, 422);
  assert.equal((await request('/action', jsonInit({ cwd: repo, name: 'fetch' }))).status, 502);
  assert.equal((await request('/worktrees/archive', jsonInit({ path: repo, force: true }))).status, 403);

  // Revision selectors never become Git options or revision expressions.
  const sentinel = join(sandbox, 'git-output-sentinel');
  const invalidBases = [`--output=${sentinel}`, '--ext-diff', 'HEAD~1', 'refs/heads/main^'];
  for (const value of invalidBases) {
    const result = await request(`/diff?cwd=${encodeURIComponent(repo)}&mode=base&base=${encodeURIComponent(value)}`);
    assert.equal(result.status, 422, value);
  }
  assert.equal(existsSync(sentinel), false);
  for (const value of ['--all', 'HEAD', git(repo, 'rev-parse', 'HEAD').trim().slice(0, 12), 'not-hex']) {
    const result = await request(`/diff?cwd=${encodeURIComponent(repo)}&commit=${encodeURIComponent(value)}`);
    assert.equal(result.status, 422, value);
  }
  assert.equal((await request(`/diff?cwd=${encodeURIComponent(repo)}&commit=${'0'.repeat(40)}`)).status, 404);

  const poisonedMetadata = await metadataPathFor(repo);
  mkdirSync(dirname(poisonedMetadata), { recursive: true });
  writeFileSync(poisonedMetadata, JSON.stringify({
    version: 1,
    baseRef: `--output=${sentinel}`,
    baseRefName: `--output=${sentinel}`,
    intent: 'branch-off',
    branch: 'main',
    mainRepoRoot: repo,
    createdAt: Date.now(),
  }));
  assert.equal((await request(`/commits?cwd=${encodeURIComponent(repo)}`)).status, 422);
  assert.equal((await request('/action', jsonInit({ cwd: repo, name: 'updateFromBase' }))).status, 409);
  const stateProbe = createGitStateHub({ onChange: () => {} });
  await stateProbe.snapshotFor(repo, { fresh: true });
  await stateProbe.dispose();
  assert.equal(existsSync(sentinel), false);
  rmSync(poisonedMetadata, { force: true });

  for (const name of ['--output=x', ':(glob)**']) {
    writeFileSync(join(repo, name), 'tracked\n');
  }
  git(repo, 'add', '--', '--output=x', ':(literal):(glob)**');
  git(repo, 'commit', '-m', 'literal pathspec probes');
  writeFileSync(join(repo, '--output=x'), 'modified output\n');
  writeFileSync(join(repo, ':(glob)**'), 'modified glob\n');
  for (const name of ['--output=x', ':(glob)**']) {
    const result = await request(`/diff?cwd=${encodeURIComponent(repo)}&path=${encodeURIComponent(name)}`);
    assert.equal(result.status, 200, name);
    assert.deepEqual(result.body.files.map((file) => file.path), [name]);
  }
  assert.equal((await request(`/diff?cwd=${encodeURIComponent(repo)}&mode=session`)).status, 200);
  const head = git(repo, 'rev-parse', 'HEAD').trim();
  assert.equal((await request(`/diff?cwd=${encodeURIComponent(repo)}&commit=${head}`)).status, 200);
  assert.equal((await request(`/diff?cwd=${encodeURIComponent(repo)}&mode=base&base=refs%2Fheads%2Fmain`)).status, 200);
  assert.equal((await request('/worktrees', jsonInit({ cwd: repo, base: 'HEAD~1', intent: 'branch-off' }))).status, 422);
  assert.equal((await request('/worktrees', jsonInit({ cwd: repo, base: 'main', intent: 'branch-off', branchName: '--detach' }))).status, 422);
  assert.equal((await request('/worktrees', jsonInit({
    cwd: repo,
    pull: { host: 'github.com', owner: 'safe', repo: 'repo', number: 1, headRef: 'safe-head', baseRef: `--output=${sentinel}` },
  }))).status, 422);
  assert.equal(existsSync(sentinel), false);

  // A real managed worktree is usable before registry registration, but only
  // while its exact source repository remains registered. Arbitrary path data
  // nested under the DSH namespace is not enough.
  const managedOne = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'security-one' });
  const managedTwo = await createWorktree({ repoRoot: repo, base: 'main', intent: 'branch-off', branchName: 'security-two' });
  assert.equal((await request(`/snapshot?cwd=${encodeURIComponent(managedOne.path)}`)).status, 200);
  roots = [repo, nested, plain, managedOne.path];
  const registeredManaged = await request(`/detect?path=${encodeURIComponent(managedOne.path)}`);
  assert.equal(registeredManaged.status, 200);
  assert.equal(registeredManaged.body.managed, true, 'registered managed worktrees retain task-diff identity');
  roots = [nested, plain];
  assert.equal((await request(`/snapshot?cwd=${encodeURIComponent(managedOne.path)}`)).status, 403);
  roots = [nested, plain, managedOne.path];
  assert.equal((await request(`/snapshot?cwd=${encodeURIComponent(managedOne.path)}`)).status, 200);
  assert.equal((await request(`/snapshot?cwd=${encodeURIComponent(managedTwo.path)}`)).status, 403, 'one linked Workspace cannot authorize a sibling');
  assert.equal((await request('/worktrees/cleanup', jsonInit({ cwd: managedOne.path }))).status, 403);
  roots = [repo, nested, plain];

  // merge-to-base may target another linked worktree; that target needs its
  // own authority unless it is the server-derived main checkout.
  const mergeFamily = join(sandbox, 'merge-family');
  initRepo(mergeFamily);
  git(mergeFamily, 'checkout', '-b', 'parking');
  const mergeTask = join(sandbox, 'merge-task');
  const mergeOwner = join(sandbox, 'merge-owner');
  git(mergeFamily, 'worktree', 'add', '-b', 'task', mergeTask, 'main');
  git(mergeFamily, 'worktree', 'add', mergeOwner, 'main');
  writeFileSync(join(mergeTask, 'task.txt'), 'task\n');
  git(mergeTask, 'add', '-A');
  git(mergeTask, 'commit', '-m', 'task');
  const ownerBefore = git(mergeOwner, 'rev-parse', 'HEAD').trim();
  roots = [nested, plain, mergeTask];
  const deniedMerge = await request('/action', jsonInit({ cwd: mergeTask, name: 'mergeToBase' }));
  assert.equal(deniedMerge.status, 403, JSON.stringify(deniedMerge.body));
  assert.equal(git(mergeOwner, 'rev-parse', 'HEAD').trim(), ownerBefore);
  roots = [repo, nested, plain];

  const archiveOther = await request('/action', jsonInit({
    cwd: managedOne.path,
    name: 'archive',
    params: { path: managedTwo.path, force: true },
  }));
  assert.equal(archiveOther.status, 403, JSON.stringify(archiveOther.body));
  assert.equal(existsSync(managedOne.path), true, 'mismatched archive selector preserves authorized cwd');
  assert.equal(existsSync(managedTwo.path), true, 'mismatched archive selector preserves target');
  writeFileSync(join(managedOne.path, 'dirty.txt'), 'dirty\n');
  const unsafeArchive = await request('/action', jsonInit({ cwd: managedOne.path, name: 'archive', params: { force: false } }));
  assert.equal(unsafeArchive.status, 409, JSON.stringify(unsafeArchive.body));
  assert.equal(existsSync(managedOne.path), true);
  const archiveOwn = await request('/action', jsonInit({
    cwd: managedOne.path,
    name: 'archive',
    params: { path: managedOne.path, force: true },
  }));
  assert.equal(archiveOwn.status, 200, JSON.stringify(archiveOwn.body));
  assert.equal((await archiveWorktree(managedTwo.path, { force: true })).ok, true);

  const fake = join(process.env.DSH_HOME, 'worktrees', 'deadbeef', 'fake');
  initRepo(fake);
  const fakeMetadata = await metadataPathFor(fake);
  mkdirSync(dirname(fakeMetadata), { recursive: true });
  writeFileSync(fakeMetadata, JSON.stringify({
    version: 1,
    baseRef: git(fake, 'rev-parse', 'HEAD').trim(),
    baseRefName: 'main',
    intent: 'branch-off',
    branch: 'fake',
    mainRepoRoot: repo,
    createdAt: Date.now(),
  }));
  assert.equal((await request(`/snapshot?cwd=${encodeURIComponent(fake)}`)).status, 403);

  // The per-repository hash directory itself is an ownership anchor, never a
  // symlink that can delegate the managed namespace to an attacker directory.
  const symlinkSource = join(sandbox, 'symlink-source');
  const attackerGroup = join(sandbox, 'attacker-group');
  const attackerWorktree = join(attackerGroup, 'evil');
  initRepo(symlinkSource);
  mkdirSync(attackerGroup);
  git(symlinkSource, 'worktree', 'add', '-b', 'evil', attackerWorktree, 'main');
  const attackerMetadata = await metadataPathFor(attackerWorktree);
  mkdirSync(dirname(attackerMetadata), { recursive: true });
  writeFileSync(attackerMetadata, JSON.stringify({
    version: 1,
    baseRef: git(symlinkSource, 'rev-parse', 'main').trim(),
    baseRefName: 'main',
    intent: 'branch-off',
    branch: 'evil',
    slug: 'evil',
    mainRepoRoot: symlinkSource,
    createdAt: Date.now(),
  }));
  const claimedGroup = await repoWorktreesRoot(symlinkSource);
  mkdirSync(dirname(claimedGroup), { recursive: true });
  symlinkSync(attackerGroup, claimedGroup);
  await assert.rejects(
    createWorktree({ repoRoot: symlinkSource, base: 'main', intent: 'branch-off', branchName: 'escaped-create' }),
    /managed root.*rebound/i,
  );
  assert.equal(existsSync(join(attackerGroup, 'escaped-create')), false);
  const symlinkManaged = await validateManagedWorktree(attackerWorktree, { expectedMainRoot: symlinkSource });
  assert.equal(symlinkManaged.ok, false);
  assert.equal(symlinkManaged.reason, 'managed-root-rebound');

  // File-only authority for a registered Git subdirectory still shares the
  // containing repository's mutation gate (without gaining Git action rights).
  const nestedFile = join(nested, 'nested-gated.txt');
  writeFileSync(nestedFile, 'before\n');
  const nestedSha1 = createHash('sha1').update(readFileSync(nestedFile)).digest('hex');
  const gitFamilyKey = `git:${repo}`;
  const releaseGitFamily = await hostMutationCoordinator.acquire(gitFamilyKey);
  let markNestedQueued;
  const nestedQueued = new Promise((resolveQueued) => { markNestedQueued = resolveQueued; });
  observeMutation = (key) => {
    if (key === gitFamilyKey) markNestedQueued();
  };
  const nestedSave = request('/file', jsonInit({ cwd: nested, path: 'nested-gated.txt', content: 'after\n', baseSha1: nestedSha1 }));
  let nestedTimeout;
  await Promise.race([
    nestedQueued,
    new Promise((_, reject) => { nestedTimeout = setTimeout(() => reject(new Error('nested file did not reach Git family gate')), 3000); }),
  ]);
  clearTimeout(nestedTimeout);
  observeMutation = null;
  assert.equal(readFileSync(nestedFile, 'utf8'), 'before\n');
  releaseGitFamily();
  const nestedResponse = await nestedSave;
  if (nestedResponse.status === 200) {
    assert.equal(readFileSync(nestedFile, 'utf8'), 'after\n');
  } else {
    assert.equal(nestedResponse.status, 503, JSON.stringify(nestedResponse.body));
    assert.match(nestedResponse.body?.message || '', /atomic file exchange unavailable/);
    assert.equal(readFileSync(nestedFile, 'utf8'), 'before\n');
    assert.equal(readdirSync(nested).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false);
  }

  // Authorization is captured before queueing, then re-proven after the outer
  // workspace gate. Reusing the same lexical root with a new inode must not let
  // an old queued file save mutate the replacement workspace.
  const staleFile = join(plain, 'stale.txt');
  writeFileSync(staleFile, 'old workspace\n');
  const baseSha1 = createHash('sha1').update(readFileSync(staleFile)).digest('hex');
  const mutationKey = `workspace:${plain}`;
  const releaseOwner = await hostMutationCoordinator.acquire(mutationKey);
  let markQueued;
  const reachedGate = new Promise((resolveQueued) => { markQueued = resolveQueued; });
  observeMutation = (key) => {
    if (key === mutationKey) markQueued();
  };
  const queuedSave = request('/file', jsonInit({
    cwd: plain,
    path: 'stale.txt',
    content: 'queued overwrite\n',
    baseSha1,
  }));
  let gateTimeout;
  await Promise.race([
    reachedGate,
    new Promise((_, reject) => { gateTimeout = setTimeout(() => reject(new Error('file mutation did not reach gate')), 3000); }),
  ]);
  clearTimeout(gateTimeout);
  observeMutation = null;
  const oldPlain = `${plain}-old-inode`;
  renameSync(plain, oldPlain);
  mkdirSync(plain);
  writeFileSync(join(plain, 'stale.txt'), 'replacement workspace\n');
  releaseOwner();
  const staleResponse = await queuedSave;
  assert.equal(staleResponse.status, 409, staleResponse.text);
  assert.equal(readFileSync(join(plain, 'stale.txt'), 'utf8'), 'replacement workspace\n');
  rmSync(plain, { recursive: true, force: true });
  renameSync(oldPlain, plain);

// Path-mode saves (Windows/macOS, ADR 0013) must still break an in-workspace
// hard-link alias instead of writing through the shared inode outside the
// authorized root: the rename replace swaps the directory entry, and the CAS
// re-check immediately before it keeps concurrent writers detectable.
{
  const stable = await import('../lib/stable.js');
  const aliasRepo = join(sandbox, 'alias-path-mode');
  initRepo(aliasRepo);
  roots = [...roots, aliasRepo];
  const outsideAlias = join(sandbox, 'outside-alias.txt');
  const insideAlias = join(aliasRepo, 'inside-alias.txt');
  writeFileSync(outsideAlias, 'alias-before\n');
  linkSync(outsideAlias, insideAlias);
  const aliasSha = createHash('sha1').update(readFileSync(insideAlias)).digest('hex');
  stable.__setPlatformForTests('win32');
  let savedAlias;
  try {
    savedAlias = await request('/file', jsonInit({
      cwd: aliasRepo,
      path: 'inside-alias.txt',
      content: 'alias-after\n',
      baseSha1: aliasSha,
    }));
  } finally {
    stable.__setPlatformForTests(null);
  }
  assert.equal(savedAlias.status, 200, JSON.stringify(savedAlias.body));
  assert.equal(readFileSync(insideAlias, 'utf8'), 'alias-after\n');
  assert.equal(readFileSync(outsideAlias, 'utf8'), 'alias-before\n',
    'the rename replace must break the alias, not mutate the outside inode');
  assert.notEqual(statSync(insideAlias).ino, statSync(outsideAlias).ino);
  assert.equal(readdirSync(aliasRepo).some((name) => name.startsWith('.bw-') && name.endsWith('.tmp')), false,
    'path-mode save removes its owned temporary file before responding');
}

console.log('SECURITY: ALL PASS');
} finally {
  api.dispose();
  await new Promise((resolve) => server.close(resolve));
  rmSync(sandbox, { recursive: true, force: true });
}
