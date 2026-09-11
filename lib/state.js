/**
 * state.js — the git-state hub (paseo's workspace-git-service, miniature).
 *
 * Per target cwd we keep a folded snapshot (branch, dirty, ahead/behind,
 * upstream, diffStat, PR + checks, forge auth). Freshness:
 *   - fs watchers on the working tree (1 s debounce) and the git dir refs;
 *     watcher failure degrades to 5 s polling (paseo's fallback);
 *   - background `git fetch origin --prune` every 180 s per repo;
 *   - PR/checks adaptive poll: 20 s while checks pending, 120 s idle,
 *     exponential error backoff capped at 300 s, batched ≤20 per gh call;
 *   - fingerprint dedupe: identical snapshots are never re-emitted.
 * Targets not accessed for 3 minutes are pruned (watchers closed).
 */
import { watch } from 'node:fs';
import { join } from 'node:path';
import {
  aheadBehind,
  currentBranchInfo,
  detectRepo,
  diffStat,
  originBranchDelta,
  originUrl,
  porcelainStatus,
  resolveBestComparisonBaseRef,
  resolveDefaultBranch,
  runGit,
  upstreamInfo,
} from './git.js';
import { readMetadata, worktreesRoot, mainRepoRootOf } from './worktree.js';
import { ghAuthenticated, ghAvailable, parseGithubRemote, prStatusBatch } from './forge.js';

const SNAPSHOT_FRESH_MS = 3000;
const WATCH_DEBOUNCE_MS = 1000;
const MIN_COMPUTE_GAP_MS = 2000;
const DEGRADED_POLL_MS = 5000;
const TARGET_TTL_MS = 180000;
const FETCH_INTERVAL_MS = 180000;
const TICK_MS = 5000;
const PR_PENDING_MS = 20000;
const PR_IDLE_MS = 120000;
const PR_BACKOFF_CAP_MS = 300000;
const NEGATIVE_TTL_MS = 30000;

export function createGitStateHub({ onChange } = {}) {
  const targets = new Map(); // cwd → target
  const negatives = new Map(); // non-git path → checkedAt
  const repos = new Map(); // mainRoot → { cwds:Set, nextFetchAt, fetching }
  const emit = (snapshot) => {
    if (typeof onChange !== 'function') return;
    try {
      onChange(snapshot);
    } catch {
      /* listener faults must not break the hub */
    }
  };

  let disposed = false;

  /* ---------------- target lifecycle ---------------- */

  async function ensureTarget(cwd) {
    if (disposed || !cwd) return null;
    const existing = targets.get(cwd);
    if (existing) {
      existing.lastAccess = Date.now();
      return existing;
    }
    const neg = negatives.get(cwd);
    if (neg && Date.now() - neg < NEGATIVE_TTL_MS) return null;
    const detect = await detectRepo(cwd);
    if (!detect.isGit) {
      negatives.set(cwd, Date.now());
      return null;
    }
    const target = {
      cwd,
      repoRoot: detect.repoRoot,
      mainRoot: detect.mainRepoRoot,
      gitCommonDir: detect.gitCommonDir,
      isLinkedWorktree: detect.isLinkedWorktree,
      lastAccess: Date.now(),
      lastComputeAt: 0,
      snapshot: null,
      fingerprint: null,
      computing: null,
      debounceTimer: null,
      watchers: [],
      degradedTimer: null,
      nextPrAt: 0,
      prBackoffMs: 0,
      disposed: false,
    };
    targets.set(cwd, target);
    let repo = repos.get(target.mainRoot);
    if (!repo) {
      repo = { cwds: new Set(), nextFetchAt: 0, fetching: false, hasOrigin: null };
      repos.set(target.mainRoot, repo);
    }
    repo.cwds.add(cwd);
    startWatchers(target);
    scheduleCompute(target, 0, true); // initial compute ASAP
    scheduleFetch(target.mainRoot, 0); // initial fetch ASAP (background)
    return target;
  }

  function disposeTarget(target) {
    target.disposed = true;
    for (const w of target.watchers) {
      try {
        w.close();
      } catch {
        /* already dead */
      }
    }
    target.watchers = [];
    if (target.degradedTimer) clearInterval(target.degradedTimer);
    if (target.debounceTimer) clearTimeout(target.debounceTimer);
    const repo = repos.get(target.mainRoot);
    if (repo) {
      repo.cwds.delete(target.cwd);
      if (repo.cwds.size === 0) repos.delete(target.mainRoot);
    }
    targets.delete(target.cwd);
  }

  /* ---------------- watchers ---------------- */

  function startWatchers(target) {
    const schedule = (filename) => {
      // ref echoes during our own fetch are fine — debounce absorbs them
      scheduleCompute(target, WATCH_DEBOUNCE_MS, true);
    };
    const attach = (path, opts) => {
      try {
        const w = watch(path, opts, (eventType, filename) => schedule(filename));
        w.on('error', () => degrade(target));
        target.watchers.push(w);
        return true;
      } catch {
        return false;
      }
    };
    let ok = attach(target.repoRoot, { recursive: true });
    if (target.gitCommonDir) {
      ok = attach(join(target.gitCommonDir, 'refs'), { recursive: true }) || ok;
      ok = attach(target.gitCommonDir, { recursive: false }) || ok; // packed-refs + worktrees metadata
    }
    if (!ok) degrade(target);
  }

  function degrade(target) {
    for (const w of target.watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
    target.watchers = [];
    if (target.degradedTimer || target.disposed) return;
    target.degradedTimer = setInterval(() => {
      scheduleCompute(target, 0, true);
    }, DEGRADED_POLL_MS);
  }

  /* ---------------- compute ---------------- */

  function scheduleCompute(target, delayMs, force) {
    if (target.disposed || disposed) return;
    if (target.debounceTimer) clearTimeout(target.debounceTimer);
    const run = () => {
      target.debounceTimer = null;
      computeTarget(target, force).catch(() => {
        /* compute failures are recoverable; next tick retries */
      });
    };
    if (delayMs > 0) target.debounceTimer = setTimeout(run, delayMs);
    else run();
  }

  async function computeTarget(target, force = false) {
    if (target.disposed || disposed) return target.snapshot;
    if (!force && target.snapshot && Date.now() - target.lastComputeAt < MIN_COMPUTE_GAP_MS) {
      return target.snapshot;
    }
    if (target.computing) return target.computing;
    const promise = (async () => {
      const cwd = target.cwd;
      const [branchInfo, status, metadata, defaultBranch] = await Promise.all([
        currentBranchInfo(cwd),
        porcelainStatus(cwd),
        readMetadata(cwd).catch(() => null),
        resolveDefaultBranch(cwd),
      ]);
      const branch = branchInfo.branch;
      const baseName = metadata?.baseRefName || defaultBranch;
      const bestBase = baseName ? await resolveBestComparisonBaseRef(cwd, baseName) : null;
      // A display branch can move or disappear. Managed metadata also records
      // the immutable base commit, which remains the comparison fallback.
      const comparisonBase = bestBase || metadata?.baseRef || null;
      const [abResult, upstream, remote] = await Promise.all([
        comparisonBase
          ? aheadBehind(cwd, comparisonBase)
          : Promise.resolve(branchInfo.ok
            ? { ok: true, ahead: 0, behind: 0 }
            : { ok: false, ahead: null, behind: null, error: branchInfo.error || 'cannot resolve HEAD' }),
        branch ? upstreamInfo(cwd, branch) : Promise.resolve({ upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 }),
        originUrl(cwd),
      ]);
      const originDeltaResult = branch && !upstream.upstreamRef ? await originBranchDelta(cwd, branch) : null;
      const degraded = [];
      if (!branchInfo.ok) degraded.push({ stage: 'head', message: branchInfo.error || 'cannot resolve HEAD' });
      if (!status.ok) degraded.push({ stage: 'status', message: status.error || 'git status failed' });
      if (!abResult.ok) degraded.push({ stage: 'ahead-behind', message: abResult.error || 'git rev-list failed' });
      if (originDeltaResult && !originDeltaResult.ok) degraded.push({ stage: 'origin-delta', message: originDeltaResult.error || 'git rev-list failed' });
      const originDelta = originDeltaResult && originDeltaResult.ok
        ? { ahead: originDeltaResult.ahead, behind: originDeltaResult.behind }
        : null;
      // comparison ref for the badge DiffStat (paseo): base branch when current≠base,
      // else origin/<current> when it exists
      let comparisonRef = comparisonBase;
      if (branch && baseName && branch === baseName && originDelta) comparisonRef = `refs/remotes/origin/${branch}`;
      const statResult = await diffStat(cwd, comparisonRef);
      if (!statResult.ok) degraded.push({ stage: 'diff-stat', message: statResult.error || 'git diff failed' });
      const ab = abResult.ok
        ? { ahead: abResult.ahead, behind: abResult.behind }
        : null;
      const stat = statResult.ok
        ? { additions: statResult.additions, deletions: statResult.deletions, files: statResult.files }
        : target.snapshot?.diffStat ?? null;
      const github = parseGithubRemote(remote);
      let forgeAuth = 'no_remote';
      if (github) {
        if (!(await ghAvailable())) forgeAuth = 'cli_missing';
        else if (!(await ghAuthenticated())) forgeAuth = 'unauthenticated';
        else forgeAuth = 'ok';
      }
      const managed = Boolean(
        metadata && (cwd.startsWith(worktreesRoot() + '/') || target.repoRoot.startsWith(worktreesRoot() + '/')),
      );
      const statusEntries = status.ok ? status.entries : null;
      const untrackedCount = statusEntries
        ? statusEntries.filter((entry) => entry.code === '??').length
        : target.snapshot?.untrackedCount ?? null;
      let pr = target.snapshot?.pr ?? null;
      // first compute fetches PR inline so the badge appears without waiting for the poll grid
      if (!target.snapshot && github && branch && forgeAuth === 'ok') {
        try {
          const result = await prStatusBatch([
            { key: cwd, owner: github.owner, repo: github.repo, headRef: branch, headSha: branchInfo.sha },
          ]);
          pr = result.get(cwd)?.pr ?? null;
          target.nextPrAt = Date.now() + (pr?.checks?.status === 'pending' ? PR_PENDING_MS : PR_IDLE_MS);
        } catch {
          /* poll loop retries */
        }
      }
      const snapshot = {
        cwd,
        isGit: true,
        repoRoot: target.repoRoot,
        mainRepoRoot: target.mainRoot,
        isLinkedWorktree: target.isLinkedWorktree,
        managed,
        baseRefName: baseName ?? null,
        baseRef: comparisonBase,
        defaultBranch: defaultBranch ?? null,
        branch,
        detached: Boolean(branchInfo.detached),
        detachedShort: branchInfo.detachedShort ?? null,
        sha: branchInfo.sha ?? null,
        unborn: Boolean(branchInfo.unborn),
        dirty: status.ok ? status.dirty : target.snapshot?.dirty ?? null,
        changedFileCount: statusEntries ? statusEntries.length : target.snapshot?.changedFileCount ?? null,
        untrackedCount,
        aheadBehind: ab,
        upstream: upstream.upstreamRef
          ? { ref: upstream.upstreamRef, ahead: upstream.aheadOfOrigin, behind: upstream.behindOfOrigin }
          : null,
        originDelta,
        diffStat: stat,
        remote,
        github,
        forgeAuth,
        pr,
        gitKnown: {
          head: branchInfo.ok,
          status: status.ok,
          aheadBehind: abResult.ok,
          originDelta: branchInfo.ok && (originDeltaResult === null || originDeltaResult.ok),
          diffStat: statResult.ok,
        },
        degraded,
        at: Date.now(),
      };
      const fingerprint = JSON.stringify({ ...snapshot, at: undefined });
      target.lastComputeAt = Date.now();
      const changed = fingerprint !== target.fingerprint;
      target.snapshot = snapshot;
      target.fingerprint = fingerprint;
      target.github = github;
      if (changed) emit(snapshot);
      return snapshot;
    })().finally(() => {
      target.computing = null;
    });
    target.computing = promise;
    return promise;
  }

  /* ---------------- background fetch (180 s per repo) ---------------- */

  function scheduleFetch(mainRoot, delayMs) {
    const repo = repos.get(mainRoot);
    if (!repo || disposed) return;
    repo.nextFetchAt = Date.now() + delayMs;
  }

  async function runDueFetches() {
    const now = Date.now();
    for (const [mainRoot, repo] of [...repos.entries()]) {
      if (repo.fetching || now < repo.nextFetchAt || repo.cwds.size === 0) continue;
      if (repo.hasOrigin === null) {
        const url = await originUrl(mainRoot);
        repo.hasOrigin = Boolean(url);
      }
      repo.nextFetchAt = now + FETCH_INTERVAL_MS;
      if (!repo.hasOrigin) continue;
      repo.fetching = true;
      runGit(['fetch', 'origin', '--prune'], { cwd: mainRoot, timeout: 120000 })
        .then((fetchResult) => {
          if (!fetchResult.ok) return;
          for (const cwd of repo.cwds) {
            const target = targets.get(cwd);
            if (target) scheduleCompute(target, WATCH_DEBOUNCE_MS, true);
          }
        })
        .finally(() => {
          repo.fetching = false;
        });
    }
  }

  /* ---------------- adaptive PR/checks poll ---------------- */

  async function runDuePrPolls() {
    const now = Date.now();
    const due = [];
    for (const target of targets.values()) {
      const s = target.snapshot;
      if (!s || !s.github || !s.branch || s.forgeAuth !== 'ok') continue;
      if (now < target.nextPrAt) continue;
      due.push(target);
    }
    if (due.length === 0) return;
    const batch = due.slice(0, 20).map((t) => ({
      key: t.cwd,
      owner: t.snapshot.github.owner,
      repo: t.snapshot.github.repo,
      headRef: t.snapshot.branch,
      headSha: t.snapshot.sha,
    }));
    let results;
    try {
      results = await prStatusBatch(batch);
    } catch {
      for (const t of due.slice(0, 20)) {
        t.prBackoffMs = Math.min(Math.max(t.prBackoffMs * 2, PR_PENDING_MS), PR_BACKOFF_CAP_MS);
        t.nextPrAt = Date.now() + t.prBackoffMs;
      }
      return;
    }
    for (const t of due.slice(0, 20)) {
      const value = results.get(t.cwd);
      if (!value || !t.snapshot) {
        t.nextPrAt = Date.now() + PR_IDLE_MS;
        continue;
      }
      if (value.forgeAuth === 'error') {
        t.prBackoffMs = Math.min(Math.max(t.prBackoffMs * 2, PR_PENDING_MS), PR_BACKOFF_CAP_MS);
        t.nextPrAt = Date.now() + t.prBackoffMs;
        continue;
      }
      t.prBackoffMs = 0;
      const pr = value.pr ?? null;
      const prev = JSON.stringify(t.snapshot.pr ?? null);
      t.snapshot = { ...t.snapshot, pr, at: Date.now() };
      t.fingerprint = JSON.stringify({ ...t.snapshot, at: undefined });
      t.nextPrAt = Date.now() + (pr?.checks?.status === 'pending' ? PR_PENDING_MS : PR_IDLE_MS);
      if (prev !== JSON.stringify(pr ?? null)) emit(t.snapshot);
    }
  }

  /* ---------------- prune ---------------- */

  function pruneStale() {
    const cutoff = Date.now() - TARGET_TTL_MS;
    for (const target of [...targets.values()]) {
      if (target.lastAccess < cutoff) disposeTarget(target);
    }
  }

  const tickTimer = setInterval(() => {
    if (disposed) return;
    runDueFetches().catch(() => {});
    runDuePrPolls().catch(() => {});
  }, TICK_MS);
  const pruneTimer = setInterval(() => {
    if (!disposed) pruneStale();
  }, 60000);

  /* ---------------- public face ---------------- */

  let lastGlobalRefresh = 0;
  return {
    /** Fresh snapshot for one cwd (computes on demand, 3 s cache; `fresh:true` skips the cache). */
    async snapshotFor(cwd, opts = {}) {
      const target = await ensureTarget(cwd);
      if (!target) {
        const neg = { cwd, isGit: false, at: Date.now() };
        return neg;
      }
      target.lastAccess = Date.now();
      if (opts.fresh && target.computing) {
        try { await target.computing; } catch { /* stale attempt; recompute below */ }
      }
      if (!opts.fresh && target.snapshot && Date.now() - target.lastComputeAt < SNAPSHOT_FRESH_MS) {
        return target.snapshot;
      }
      return (await computeTarget(target, Boolean(opts.fresh))) ?? target.snapshot ?? { cwd, isGit: false };
    },
    /** Batch snapshots (sidebar). */
    async snapshots(cwds) {
      const unique = [...new Set((cwds ?? []).filter((c) => typeof c === 'string' && c !== ''))].slice(0, 200);
      const results = await Promise.all(unique.map((cwd) => this.snapshotFor(cwd)));
      const byCwd = {};
      results.forEach((snapshot, i) => {
        byCwd[unique[i]] = snapshot;
      });
      return byCwd;
    },
    /** Force an immediate recompute (after mutations / session events); resolves with the fresh snapshot. */
    async invalidate(cwd) {
      negatives.delete(cwd);
      const target = await ensureTarget(cwd);
      if (!target) return null;
      target.lastAccess = Date.now();
      if (target.computing) {
        try { await target.computing; } catch { /* join then supersede */ }
      }
      return computeTarget(target, true);
    },
    /** Throttled refresh of every active target (tools/result wiring). */
    refreshActive() {
      const now = Date.now();
      if (now - lastGlobalRefresh < 5000) return;
      lastGlobalRefresh = now;
      for (const target of targets.values()) scheduleCompute(target, WATCH_DEBOUNCE_MS, true);
    },
    /** Read the cached snapshot without computing (may be null). */
    peek(cwd) {
      return targets.get(cwd)?.snapshot ?? null;
    },
    isKnownGit(cwd) {
      return targets.has(cwd);
    },
    async dispose() {
      disposed = true;
      clearInterval(tickTimer);
      clearInterval(pruneTimer);
      for (const target of [...targets.values()]) disposeTarget(target);
      targets.clear();
      repos.clear();
    },
  };
}

export { mainRepoRootOf };
