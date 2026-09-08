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
import { realpath, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

const READ_ONLY_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
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
 * Run one git command; never rejects — non-zero exits resolve with ok:false
 * (or ok:true when the caller passes allowFail, e.g. `diff --no-index`
 * which exits 1 when files differ).
 */
export function runGit(args, opts = {}) {
  const { cwd, timeout = 30000, env, allowFail = false } = opts;
  return limit(
    () =>
      new Promise((resolve) => {
        execFile(
          'git',
          args,
          {
            cwd,
            timeout,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, ...READ_ONLY_ENV, ...(env || {}) },
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve({ ok: true, code: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
              return;
            }
            const code = typeof error.code === 'number' ? error.code : 1;
            resolve({
              ok: allowFail,
              code,
              stdout: String(stdout ?? ''),
              stderr: String(stderr ?? error.message),
              timedOut: Boolean(error.killed),
            });
          },
        );
      }),
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
      if (kind === 'head') entry.hasLocal = true;
      else entry.hasRemote = true;
      byName.set(name, entry);
    }
  };
  absorb(heads, 'head');
  absorb(remotes, 'remote');
  const branches = [...byName.values()].sort((a, b) => b.committerDate - a.committerDate || a.name.localeCompare(b.name));
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
  return r.ok && /^[0-9a-f]{7,40}$/.test(sha) ? sha : null;
}

/* ------------------------------------------------------------------ */
/* status                                                              */
/* ------------------------------------------------------------------ */

/**
 * Current branch facts. Detached HEAD → branch null + short sha.
 * Unborn HEAD (no commits) → branch = symbolic name, unborn: true.
 */
export async function currentBranchInfo(cwd) {
  const symbolic = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  const headSha = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  const sha = headSha.ok ? headSha.stdout.trim() : null;
  if (symbolic.ok && symbolic.stdout.trim()) {
    return { branch: symbolic.stdout.trim(), detached: false, sha, unborn: sha === null };
  }
  return { branch: null, detached: sha !== null, sha, unborn: false, detachedShort: sha ? sha.slice(0, 7) : null };
}

/** `git status --porcelain` → { dirty, entries:[{code,path}] } */
export async function porcelainStatus(cwd) {
  const r = await runGit(['status', '--porcelain'], { cwd });
  if (!r.ok) return { dirty: false, entries: [], error: r.stderr };
  const entries = [];
  for (const line of r.stdout.split('\n')) {
    if (line.length < 4) continue;
    entries.push({ code: line.slice(0, 2), path: line.slice(3) });
  }
  return { dirty: entries.length > 0, entries };
}

/**
 * ahead/behind of HEAD versus a comparison ref
 * (`rev-list --left-right --count base...HEAD`: left = behind, right = ahead).
 */
export async function aheadBehind(cwd, baseRef) {
  if (!baseRef) return { ahead: 0, behind: 0 };
  const r = await runGit(['rev-list', '--left-right', '--count', `${baseRef}...HEAD`], { cwd });
  if (!r.ok) return { ahead: 0, behind: 0 };
  const [left, right] = r.stdout.trim().split(/\s+/).map((v) => Number(v) || 0);
  return { ahead: right, behind: left };
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
  if (!(await hasRemoteBranch(cwd, branch))) return null;
  return aheadBehind(cwd, `refs/remotes/origin/${branch}`);
}

/**
 * Badge DiffStat: shortstat from merge-base(comparisonRef, HEAD) to the
 * WORKING TREE (so committed + uncommitted changes count together — paseo's
 * diffStat semantics), plus line counts of untracked text files
 * (≤200 files, each ≤1 MiB, binary skipped).
 */
export async function diffStat(cwd, comparisonRef) {
  const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  const unborn = !head.ok;
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
  if (base) {
    const ss = await runGit(['diff', '--shortstat', base], { cwd, allowFail: true });
    const m = ss.stdout;
    const f = /(\d+) files? changed/.exec(m);
    const a = /(\d+) insertions?\(\+\)/.exec(m);
    const d = /(\d+) deletions?\(-\)/.exec(m);
    if (f) files += Number(f[1]);
    if (a) additions += Number(a[1]);
    if (d) deletions += Number(d[1]);
  } else {
    // no comparison ref and not unborn → uncommitted only
    const ss = await runGit(['diff', '--shortstat', 'HEAD'], { cwd, allowFail: true });
    const f = /(\d+) files? changed/.exec(ss.stdout);
    const a = /(\d+) insertions?\(\+\)/.exec(ss.stdout);
    const d = /(\d+) deletions?\(-\)/.exec(ss.stdout);
    if (f) files += Number(f[1]);
    if (a) additions += Number(a[1]);
    if (d) deletions += Number(d[1]);
  }
  // untracked line counting (paseo caps: 500 files / 1 MiB each; we use 200)
  const status = await porcelainStatus(cwd);
  const untracked = status.entries.filter((e) => e.code === '??').map((e) => e.path);
  files += untracked.length;
  let counted = 0;
  for (const rel of untracked) {
    if (counted >= 200) break;
    const abs = rel.startsWith('"') ? rel : rel;
    try {
      const s = await stat(`${cwd}/${abs}`);
      if (!s.isFile() || s.size > 1024 * 1024) continue;
      const lines = await countNewlines(`${cwd}/${abs}`);
      if (lines === null) continue; // binary
      additions += lines;
      counted += 1;
    } catch {
      /* ignore unreadable entries */
    }
  }
  return { additions, deletions, files };
}

/** Count newlines; resolve null when the head bytes look binary. */
function countNewlines(file) {
  return new Promise((resolve) => {
    let size = 0;
    let lines = 0;
    let binary = false;
    let headBytes = 0;
    const stream = createReadStream(file, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => {
      size += chunk.length;
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
    stream.on('close', () => resolve(binary ? null : lines));
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
      current = { path: line.slice('worktree '.length), branch: null, head: null, detached: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line === 'detached') current.detached = true;
    else if (line === 'bare') current.bare = true;
  }
  if (current) items.push(current);
  return items;
}

const LOG_FORMAT = '%H%x00%h%x00%an%x00%at%x00%s';

/** Commits in `range` (e.g. `<base>..HEAD`), newest first. */
export async function listCommits(cwd, range, limit = 200) {
  const r = await runGit(['log', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, range], { cwd });
  if (!r.ok) return [];
  const commits = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, short, author, at, subject] = line.split('\u0000');
    commits.push({ sha, short, author, at: Number(at) * 1000, subject });
  }
  return commits;
}

/** SHAs reachable from HEAD but not from `remoteRef` (the unpushed set). */
export async function unpushedShas(cwd, remoteRef) {
  if (!remoteRef) return new Set();
  const r = await runGit(['rev-list', `${remoteRef}..HEAD`], { cwd });
  if (!r.ok) return new Set();
  return new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean));
}

/** origin remote URL (null when absent). */
export async function originUrl(cwd) {
  const r = await runGit(['remote', 'get-url', 'origin'], { cwd });
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
