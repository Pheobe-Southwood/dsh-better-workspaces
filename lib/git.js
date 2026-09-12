/**
 * git.js — read-only git primitives over the git CLI (paseo-inspired).
 *
 * Every call goes through a bounded-concurrency scheduler (8, like paseo's
 * git-process-scheduler default). Read-only commands run with
 * GIT_OPTIONAL_LOCKS=0 / LC_ALL=C / GIT_TERMINAL_PROMPT=0 so they never
 * contend with an agent's own git usage or prompt for credentials.
 */
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { open, realpath, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { devNull } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const GIT_CHILD_GUARD = fileURLToPath(new URL('./git-child.js', import.meta.url));
const pinnedGitEnvironment = new AsyncLocalStorage();
const scopedGitAbortSignal = new AsyncLocalStorage();

/** Run a compound repository operation with dirfd-pinned Git discovery. */
export function withPinnedGitEnvironment(environment, task) {
  return pinnedGitEnvironment.run(Object.freeze({ ...(environment || {}) }), task);
}

/** Apply one lifecycle AbortSignal to every nested Git helper call. */
export function withGitAbortSignal(signal, task) {
  return scopedGitAbortSignal.run(signal, task);
}

/** Temporarily restore ordinary discovery for a newly-created worktree. */
export function withoutPinnedGitEnvironment(task) {
  return pinnedGitEnvironment.run(undefined, task);
}

const GIT_ENV = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
};
const SAFE_GIT_CONFIG = [
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${devNull}`,
  '-c', 'commit.gpgSign=false',
  '-c', 'tag.gpgSign=false',
  '-c', 'diff.external=',
  '-c', 'interactive.diffFilter=',
  '-c', 'core.sshCommand=ssh',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always',
  '-c', 'protocol.git.allow=always',
  '-c', 'protocol.http.allow=always',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
  '-c', 'protocol.ext.allow=never',
  '-c', 'remote.origin.uploadpack=git-upload-pack',
  '-c', 'remote.origin.receivepack=git-receive-pack',
  '-c', 'remote.upstream.uploadpack=git-upload-pack',
  '-c', 'remote.upstream.receivepack=git-receive-pack',
];
const AMBIENT_GIT_EXECUTION_KEYS = new Set([
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_EXTERNAL_DIFF',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
]);

function gitEnvironment(overrides) {
  const result = { ...process.env };
  for (const key of Object.keys(result)) {
    if (AMBIENT_GIT_EXECUTION_KEYS.has(key) || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete result[key];
  }
  return { ...result, ...(overrides || {}), ...(pinnedGitEnvironment.getStore() || {}), ...GIT_ENV };
}

function commandOf(args) {
  let index = 0;
  while (args[index] === '-c' && index + 1 < args.length) index += 2;
  return { command: args[index], subcommand: args[index + 1], index };
}

function hardenedGitArgs(args) {
  const copy = [...args];
  const { command, index } = commandOf(copy);
  if (command === 'diff') copy.splice(index + 1, 0, '--no-ext-diff', '--no-textconv');
  return [...SAFE_GIT_CONFIG, ...copy];
}

function executableConfigPatterns(args) {
  const { command, subcommand } = commandOf(args);
  const patterns = [];
  if (['add', 'checkout', 'reset', 'merge', 'pull', 'status', 'diff'].includes(command) || (command === 'worktree' && subcommand === 'add')) {
    patterns.push(/^filter\..+\.(?:clean|smudge|process)$/i);
  }
  if (['merge', 'pull'].includes(command)) patterns.push(/^merge\..+\.driver$/i);
  if (['fetch', 'push', 'pull', 'ls-remote'].includes(command)) {
    patterns.push(
      /^credential\.helper$/i,
      /^core\.(?:askpass|gitproxy)$/i,
      /^remote\..+\.(?:receivepack|uploadpack|vcs)$/i,
    );
  }
  return patterns;
}

async function inspectExecutableLocalConfig(cwd, args, timeout, env, signal, parentGuard = false) {
  const patterns = executableConfigPatterns(args);
  if (!cwd || patterns.length === 0) return { ok: true };
  const configArgs = [...SAFE_GIT_CONFIG, 'config', '--includes', '--show-scope', '--name-only', '-z', '--get-regexp', '.'];
  const executable = parentGuard ? process.execPath : 'git';
  const childArgs = parentGuard ? [GIT_CHILD_GUARD, 'git', ...configArgs] : configArgs;
  const result = await new Promise((resolveResult) => {
    execFile(
      executable,
      childArgs,
      { cwd, timeout: Math.min(timeout, 10000), maxBuffer: 1024 * 1024, env: gitEnvironment(env), signal },
      (error, stdout, stderr) => {
        const numericCode = typeof error?.code === 'number' ? error.code : error ? null : 0;
        if (numericCode !== 0 && numericCode !== 1) {
          resolveResult({
            ok: false,
            code: typeof error?.code === 'string' ? error.code : 'UNSAFE_REPOSITORY_CONFIG',
            message: `cannot inspect repository Git config: ${String(stderr || error?.message || 'failed').trim()}`,
          });
          return;
        }
        resolveResult({ ok: true, fields: String(stdout || '').split('\0').filter(Boolean) });
      },
    );
  });
  if (!result.ok) return result;
  for (let index = 0; index + 1 < result.fields.length; index += 2) {
    const scope = result.fields[index];
    const key = result.fields[index + 1];
    if (['local', 'worktree'].includes(scope) && patterns.some((pattern) => pattern.test(key))) {
      return { ok: false, message: `repository executable Git config is not allowed for this action: ${key}` };
    }
  }
  return { ok: true };
}
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/* ------------------------------------------------------------------ */
/* scheduler                                                           */
/* ------------------------------------------------------------------ */

function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    const task = queue.shift();
    if (task !== undefined) run(task.fn, task.resolve, task.reject);
  };
  const run = (fn, resolve, reject) => {
    active += 1;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      if (active < max) run(fn, resolve, reject);
      else queue.push({ fn, resolve, reject });
    });
}

const limit = createLimiter(8);

/**
 * Run one git command; never rejects. `ok` means the process exited with one
 * explicitly accepted code — it never means "the caller chose to ignore the
 * failure". Timeouts/kills always fail. The only current non-zero success is
 * `git diff --no-index` exit 1 (files differ), whose caller passes [0, 1].
 */
export function runGit(args, opts = {}) {
  const { cwd, timeout = 30000, env, signal: explicitSignal, parentGuard = false, acceptedExitCodes = [0] } = opts;
  const signal = explicitSignal || scopedGitAbortSignal.getStore();
  const accepted = new Set(
    Array.isArray(acceptedExitCodes)
      ? acceptedExitCodes.filter((code) => Number.isInteger(code))
      : [0],
  );
  if (accepted.size === 0) accepted.add(0);
  // The limiter may start this callback from another request's completion
  // chain. Capture and explicitly re-enter the caller's repository scope so a
  // queued Git command can neither lose its dirfd pins nor inherit a peer's.
  const callerGitEnvironment = pinnedGitEnvironment.getStore();
  const callerAbortSignal = signal;
  return limit(
    () => pinnedGitEnvironment.run(callerGitEnvironment, () => scopedGitAbortSignal.run(callerAbortSignal, async () => {
      let directory;
      let executionCwd = cwd;
      try {
        if (process.platform === 'linux' && typeof cwd === 'string') {
          if (/^\/proc\/(?:self|\d+)\/fd\/\d+$/.test(cwd)) {
            // The caller owns this already-verified dirfd for a larger compound
            // transaction. Reopening the proc magic-link with O_NOFOLLOW would
            // fail ENOTDIR and would also discard that transaction anchor.
            const info = await stat(cwd);
            if (!info.isDirectory()) throw Object.assign(new Error('stable cwd is not a directory'), { code: 'ENOTDIR' });
          } else {
            directory = await open(cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            executionCwd = `/proc/self/fd/${directory.fd}`;
          }
        }
        const guard = await inspectExecutableLocalConfig(executionCwd, args, timeout, env, signal, parentGuard);
        if (!guard.ok) {
          return { ok: false, code: guard.code || 'UNSAFE_REPOSITORY_CONFIG', stdout: '', stderr: guard.message };
        }
        const gitArgs = hardenedGitArgs(args);
        const executable = parentGuard ? process.execPath : 'git';
        const childArgs = parentGuard ? [GIT_CHILD_GUARD, 'git', ...gitArgs] : gitArgs;
        return await new Promise((resolve) => {
          execFile(
            executable,
            childArgs,
            {
              cwd: executionCwd,
              timeout,
              maxBuffer: 64 * 1024 * 1024,
              env: gitEnvironment(env),
              signal,
            },
            (error, stdout, stderr) => {
              if (!error) {
                resolve({ ok: accepted.has(0), code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
                return;
              }
              const numericCode = typeof error.code === 'number' ? error.code : null;
              const code = numericCode ?? error.code ?? 1;
              const timedOut = Boolean(error.killed);
              resolve({
                ok: numericCode !== null && !timedOut && !error.signal && accepted.has(numericCode),
                code,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? error.message),
                timedOut,
                ...(error.signal ? { signal: error.signal } : {}),
              });
            },
          );
        });
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? 1,
          stdout: '',
          stderr: String(error?.message ?? error),
          timedOut: false,
        };
      } finally {
        await directory?.close().catch(() => {});
      }
    })),
  );
}

/* ------------------------------------------------------------------ */
/* repo detection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Detect whether `path` sits inside a git working tree.
 * @returns {Promise<{isGit:false}|{isGit:true, repoRoot:string, gitDir:string, gitCommonDir:string, isLinkedWorktree:boolean, mainRepoRoot:string}>}
 */
export async function detectRepo(path) {
  if (!path) return { isGit: false };
  let probe;
  try {
    probe = (await stat(path)).isDirectory() ? path : dirname(path);
  } catch {
    return { isGit: false };
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], { cwd: probe });
  if (!top.ok || top.stdout.trim() === '') return { isGit: false };
  const repoRoot = top.stdout.trim();
  const [common, own] = await Promise.all([
    runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repoRoot }),
    runGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: repoRoot }),
  ]);
  const gitCommonDir = common.ok ? common.stdout.trim() : null;
  const gitDir = own.ok ? own.stdout.trim() : null;
  const isLinkedWorktree = Boolean(gitCommonDir && gitDir && gitCommonDir !== gitDir);
  const mainRepoRoot = isLinkedWorktree && gitCommonDir ? dirname(gitCommonDir) : repoRoot;
  return { isGit: true, repoRoot, gitDir, gitCommonDir, isLinkedWorktree, mainRepoRoot };
}

/* ------------------------------------------------------------------ */
/* branches                                                            */
/* ------------------------------------------------------------------ */

const REF_FORMAT = '%(refname)%09%(committerdate:unix)%09%(objectname)';

/**
 * Paseo-style branch suggestions: local heads + origin remotes merged by
 * short name, most recently committed first.
 */
export async function listBranches(repoRoot) {
  const [heads, remotes] = await Promise.all([
    runGit(['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, 'refs/heads'], { cwd: repoRoot }),
    runGit(['for-each-ref', '--sort=-committerdate', `--format=${REF_FORMAT}`, 'refs/remotes/origin'], {
      cwd: repoRoot,
    }),
  ]);
  const byName = new Map();
  const absorb = (result, kind) => {
    if (!result.ok) return;
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [refname, dateRaw, oid] = line.split('\t');
      if (!refname || !oid) continue;
      let name = refname;
      if (kind === 'head') name = name.replace(/^refs\/heads\//, '');
      else {
        if (name === 'refs/remotes/origin/HEAD') continue;
        name = name.replace(/^refs\/remotes\/origin\//, '');
      }
      if (!name || name.includes('/HEAD')) continue;
      const entry = byName.get(name) ?? { name, committerDate: 0, hasLocal: false, hasRemote: false };
      entry.committerDate = Math.max(entry.committerDate, Number(dateRaw) || 0);
      if (kind === 'head') {
        entry.hasLocal = true;
        entry.localOid = oid;
      } else {
        entry.hasRemote = true;
        entry.remoteOid = oid;
      }
      byName.set(name, entry);
    }
  };
  absorb(heads, 'head');
  absorb(remotes, 'remote');
  const branches = [...byName.values()].sort((a, b) => b.committerDate - a.committerDate || a.name.localeCompare(b.name));
  // divergence facts for picker rows (paseo parity): only pairs that exist on
  // both sides and point at different commits pay for a rev-list count
  const diverged = branches.filter(
    (b) => b.hasLocal && b.hasRemote && b.localOid && b.remoteOid && b.localOid !== b.remoteOid,
  );
  await Promise.all(
    diverged.map(async (b) => {
      const res = await runGit(['rev-list', '--left-right', '--count', `${b.localOid}...${b.remoteOid}`], {
        cwd: repoRoot,
      });
      if (!res.ok) return;
      const [left, right] = res.stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
      b.localAhead = left;
      b.localBehind = right;
    }),
  );
  return branches;
}

/**
 * Default branch: origin/HEAD when it resolves (prefer the local name),
 * else local main, else local master, else the unborn HEAD name, else null.
 */
export async function resolveDefaultBranch(repoRoot) {
  const sym = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd: repoRoot });
  const ref = sym.stdout.trim();
  if (sym.ok && ref) {
    const remoteShort = ref.replace(/^refs\/remotes\//, '');
    const localName = remoteShort.startsWith('origin/') ? remoteShort.slice('origin/'.length) : remoteShort;
    const local = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], {
      cwd: repoRoot,
    });
    return local.ok ? localName : remoteShort;
  }
  for (const candidate of ['main', 'master']) {
    const hit = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], {
      cwd: repoRoot,
    });
    if (hit.ok) return candidate;
  }
  const head = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: repoRoot });
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  return null;
}

/** Does refs/heads/<name> exist? */
export async function hasLocalBranch(repoRoot, name) {
  const r = await runGit(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd: repoRoot });
  return r.ok;
}

/** Does refs/remotes/origin/<name> exist? */
export async function hasRemoteBranch(repoRoot, name) {
  const r = await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${name}`], {
    cwd: repoRoot,
  });
  return r.ok;
}

/** Fetch URL of one remote, or null when the remote does not exist. */
export async function remoteUrl(cwd, name) {
  const r = await runGit(['remote', 'get-url', name], { cwd });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Prefer origin/<base> when present (background fetch keeps it fresher —
 * paseo's resolveBestComparisonBaseRef), else the local branch, else null.
 */
export async function resolveBestComparisonBaseRef(repoRoot, baseName) {
  if (!baseName) return null;
  if (baseName.startsWith('refs/') || baseName.includes('origin/')) {
    const direct = await runGit(['rev-parse', '--verify', '--quiet', baseName], { cwd: repoRoot });
    return direct.ok ? baseName : null;
  }
  if (await hasRemoteBranch(repoRoot, baseName)) return `origin/${baseName}`;
  if (await hasLocalBranch(repoRoot, baseName)) return baseName;
  return null;
}

export async function tryMergeBase(repoRoot, a, b) {
  const r = await runGit(['merge-base', a, b], { cwd: repoRoot });
  const sha = r.stdout.trim();
  return r.ok && /^[0-9a-f]{7,64}$/.test(sha) ? sha : null;
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

/** Resolve HEAD while distinguishing a genuinely missing unborn ref from corruption. */
export async function headState(cwd) {
  const resolved = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { cwd });
  if (resolved.ok) return { ok: true, unborn: false, sha: resolved.stdout.trim() };
  const symbolic = await runGit(['symbolic-ref', '--quiet', 'HEAD'], { cwd });
  if (!symbolic.ok || !symbolic.stdout.trim()) {
    return { ok: false, unborn: false, sha: null, error: resolved.stderr || symbolic.stderr || 'cannot resolve HEAD' };
  }
  // for-each-ref is available on old supported Git versions. A genuinely
  // unborn target has no row and no warning; malformed loose refs emit a
  // broken/invalid warning and must not be mistaken for an empty repository.
  const ref = symbolic.stdout.trim();
  const listed = await runGit(['for-each-ref', '--format=%(refname)%09%(objectname)', '--', ref], { cwd });
  const exactExists = listed.stdout.split('\n').some((line) => line.split('\t', 1)[0] === ref);
  if (!listed.ok || listed.stderr.trim() || exactExists) {
    return { ok: false, unborn: false, sha: null, error: listed.stderr || resolved.stderr || 'cannot resolve HEAD' };
  }
  // Prefix children may appear in stdout; only an exact row represents HEAD.
  return { ok: true, unborn: true, sha: null, ref };
}

/**
 * Current branch facts. Detached HEAD → branch null + short sha.
 * Unborn HEAD (no commits) → branch = symbolic name, unborn: true.
 */
export async function currentBranchInfo(cwd) {
  const [symbolic, head] = await Promise.all([
    runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd }),
    headState(cwd),
  ]);
  const sha = head.ok ? head.sha : null;
  if (symbolic.ok && symbolic.stdout.trim()) {
    return { ok: head.ok, branch: symbolic.stdout.trim(), detached: false, sha, unborn: head.unborn, ...(head.error ? { error: head.error } : {}) };
  }
  return {
    ok: head.ok,
    branch: null,
    detached: head.ok && sha !== null,
    sha,
    unborn: false,
    detachedShort: sha ? sha.slice(0, 7) : null,
    ...(head.error ? { error: head.error } : {}),
  };
}

/**
 * `git status --porcelain=v1 -z` with lossless paths. In -z mode rename/copy
 * records are `XY NEW\0OLD\0`; quoted display paths and `old -> new` parsing
 * never enter the domain model.
 */
export async function porcelainStatus(cwd) {
  const r = await runGit(['status', '--porcelain=v1', '-z'], { cwd });
  if (!r.ok) return { ok: false, dirty: null, entries: [], error: r.stderr || 'git status failed' };
  const records = r.stdout.split('\0');
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const entry = { code, path: record.slice(3) };
    if (/[RC]/.test(code)) entry.oldPath = records[++index] ?? null;
    entries.push(entry);
  }
  return { ok: true, dirty: entries.length > 0, entries };
}

/**
 * ahead/behind of HEAD versus a comparison ref
 * (`rev-list --left-right --count base...HEAD`: left = behind, right = ahead).
 */
export async function aheadBehind(cwd, baseRef) {
  if (!baseRef) return { ok: false, ahead: null, behind: null, error: 'comparison ref required' };
  const r = await runGit(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], { cwd });
  if (!r.ok) return { ok: false, ahead: null, behind: null, error: r.stderr || 'git rev-list failed' };
  const values = r.stdout.trim().split(/\s+/);
  const left = Number(values[0]);
  const right = Number(values[1]);
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    return { ok: false, ahead: null, behind: null, error: 'git rev-list returned invalid counts' };
  }
  return { ok: true, ahead: right, behind: left };
}

/**
 * Upstream tracking facts from `for-each-ref %(upstream) %(upstream:track,nobracket)`.
 * @returns {Promise<{upstreamRef:string|null, aheadOfOrigin:number, behindOfOrigin:number}>}
 */
export async function upstreamInfo(cwd, branch) {
  if (!branch) return { upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 };
  const r = await runGit(
    ['for-each-ref', '--format=%(upstream)%00%(upstream:track,nobracket)', `refs/heads/${branch}`],
    { cwd },
  );
  if (!r.ok) return { upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 };
  const line = r.stdout.split('\n')[0] ?? '';
  const [upstreamRaw, trackRaw] = line.split('\u0000');
  const upstreamRef = upstreamRaw && upstreamRaw.trim() !== '' ? upstreamRaw.trim() : null;
  if (!upstreamRef || (trackRaw ?? '').trim() === 'gone') {
    return { upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 };
  }
  const track = (trackRaw ?? '').trim();
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return {
    upstreamRef,
    aheadOfOrigin: ahead ? Number(ahead[1]) : 0,
    behindOfOrigin: behind ? Number(behind[1]) : 0,
  };
}

/**
 * Fallback ahead/behind versus origin/<branch> when no upstream is configured
 * (used for the "unpushed" count; paseo reads aheadOfOrigin from upstream
 * track info, we additionally probe origin/<branch> directly).
 */
export async function originBranchDelta(cwd, branch) {
  if (!branch) return null;
  const exists = await runGit(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {
    cwd,
    acceptedExitCodes: [0, 1],
  });
  if (!exists.ok) return { ok: false, exists: null, ahead: null, behind: null, error: exists.error || exists.stderr.trim() || 'git show-ref failed' };
  if (exists.code === 1) return { ok: true, exists: false, ahead: null, behind: null };
  const delta = await aheadBehind(cwd, `refs/remotes/origin/${branch}`);
  return { ...delta, exists: delta.ok ? true : null };
}

/**
 * Badge DiffStat: shortstat from merge-base(comparisonRef, HEAD) to the
 * WORKING TREE (so committed + uncommitted changes count together — paseo's
 * diffStat semantics), plus line counts of untracked text files
 * (≤200 files, each ≤1 MiB, binary skipped).
 */
export async function diffStat(cwd, comparisonRef) {
  const head = await headState(cwd);
  const unborn = head.ok && head.unborn;
  if (!head.ok) {
    return { ok: false, additions: null, deletions: null, files: null, error: head.error || 'cannot resolve HEAD' };
  }
  let base = null;
  if (comparisonRef) {
    if (unborn) base = EMPTY_TREE;
    else base = (await tryMergeBase(cwd, comparisonRef, 'HEAD')) ?? comparisonRef;
  } else if (unborn) {
    base = EMPTY_TREE;
  }
  let additions = 0;
  let deletions = 0;
  let files = 0;
  const ss = await runGit(['diff', '--shortstat', base || 'HEAD'], { cwd });
  if (!ss.ok) {
    return { ok: false, additions: null, deletions: null, files: null, error: ss.stderr || 'git diff --shortstat failed' };
  }
  const summary = ss.stdout;
  const changed = /(\d+) files? changed/.exec(summary);
  const added = /(\d+) insertions?\(\+\)/.exec(summary);
  const removed = /(\d+) deletions?\(-\)/.exec(summary);
  if (changed) files += Number(changed[1]);
  if (added) additions += Number(added[1]);
  if (removed) deletions += Number(removed[1]);

  // untracked line counting (paseo caps: 500 files / 1 MiB each; we use 200)
  const status = await porcelainStatus(cwd);
  if (!status.ok) {
    return { ok: false, additions: null, deletions: null, files: null, error: status.error };
  }
  const untracked = status.entries.filter((entry) => entry.code === '??').map((entry) => entry.path);
  files += untracked.length;
  let counted = 0;
  for (const rel of untracked) {
    if (counted >= 200) break;
    try {
      const file = `${cwd}/${rel}`;
      const s = await stat(file);
      if (!s.isFile() || s.size > 1024 * 1024) continue;
      const lines = await countNewlines(file);
      if (lines === null) continue; // binary
      additions += lines;
      counted += 1;
    } catch {
      /* unreadable untracked files do not make tracked diff facts untrustworthy */
    }
  }
  return { ok: true, additions, deletions, files };
}

/** Count text lines; resolve null when the head bytes look binary. */
function countNewlines(file) {
  return new Promise((resolve) => {
    let size = 0;
    let lines = 0;
    let binary = false;
    let headBytes = 0;
    let lastByte = null;
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (chunk.length > 0) lastByte = chunk[chunk.length - 1];
      if (headBytes < 8000) {
        const scan = chunk.subarray(0, 8000 - headBytes);
        headBytes += scan.length;
        for (const byte of scan) {
          if (byte === 0) {
            binary = true;
            break;
          }
        }
      }
      if (binary) {
        stream.destroy();
        return;
      }
      for (const byte of chunk) if (byte === 10) lines += 1;
    });
    stream.on('error', () => resolve(null));
    stream.on('close', () => resolve(binary ? null : lines + (size > 0 && lastByte !== 10 ? 1 : 0)));
  });
}

/* ------------------------------------------------------------------ */
/* worktrees & commits                                                 */
/* ------------------------------------------------------------------ */

/** `git worktree list --porcelain` parsed. */
export async function listWorktreesRaw(repoRoot) {
  const r = await runGit(['worktree', 'list', '--porcelain'], { cwd: repoRoot });
  const items = [];
  let current = null;
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '') {
      if (current) items.push(current);
      current = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, head: null, detached: false, bare: false, prunable: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
    else if (line.startsWith('prunable')) {
      current.prunable = true;
      current.prunableReason = line.slice('prunable'.length).trim() || null;
    }
  }
  if (current) items.push(current);
  return items;
}

const LOG_FORMAT = '%H%x00%h%x00%an%x00%at%x00%s';

/** Commits in `range` (e.g. `<base>..HEAD`), newest first. */
export async function listCommits(cwd, range, limit = 200) {
  const r = await runGit(['log', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, range], { cwd });
  if (!r.ok) return { ok: false, commits: null, error: r.stderr || 'git log failed' };
  const commits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, short, author, at, subject] = line.split('\u0000');
    commits.push({ sha, short, author, at: Number(at) * 1000, subject });
  }
  return { ok: true, commits };
}

/** SHAs reachable from HEAD but not from `remoteRef` (the unpushed set). */
export async function unpushedShas(cwd, remoteRef) {
  if (!remoteRef) return { ok: false, shas: null, error: 'remote ref required' };
  const r = await runGit(['rev-list', `${remoteRef}..HEAD`], { cwd });
  if (!r.ok) return { ok: false, shas: null, error: r.stderr || 'git rev-list failed' };
  return {
    ok: true,
    shas: new Set(r.stdout.split('\n').map((line) => line.trim()).filter(Boolean)),
  };
}

/** origin remote URL (null when absent). */
export async function originUrl(cwd, options = {}) {
  const r = await runGit(['remote', 'get-url', 'origin'], { cwd, signal: options.signal });
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Normalize a path to its realpath (fall back to the input) — used for
 * ownership checks and repo hashing.
 */
export async function safeRealpath(p) {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}
