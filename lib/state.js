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
import { constants, watch } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aheadBehind,
  currentBranchInfo,
  detectRepo,
  diffStat,
  originBranchDelta,
  originUrl,
  remoteUrl,
  porcelainStatus,
  resolveBestComparisonBaseRef,
  resolveDefaultBranch,
  runGit,
  upstreamInfo,
} from './git.js';
import { readMetadata, validateManagedWorktree, mainRepoRootOf } from './worktree.js';
import { forgeIdentityForCwd, forgeRepositoryKey, ghAuthenticated, ghAvailable, parseGithubRemote, prStatusBatch } from './forge.js';
import { hostMutationCoordinator } from './mutation.js';

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

function validPullProvenance(metadata) {
  return Boolean(metadata?.intent === 'pr-checkout'
    && Number.isSafeInteger(metadata.pullNumber) && metadata.pullNumber > 0
    && typeof metadata.pullHeadRef === 'string' && metadata.pullHeadRef.length > 0 && metadata.pullHeadRef.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(metadata.pullHeadRef)
    && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(metadata.prHeadSha || '')
    && forgeRepositoryKey({ host: metadata.pullHost, owner: metadata.pullOwner, repo: metadata.pullRepo }));
}

function prSelectorKey(value) {
  const { github, prNumber, prHeadRef, branch, prLookupSha, sha, prPollingDisabled } = value || {};
  if (!github || prPollingDisabled) return null;
  return JSON.stringify([
    forgeRepositoryKey(github),
    Number.isSafeInteger(prNumber) ? prNumber : null,
    prHeadRef || branch || null,
    prLookupSha || sha || null,
  ]);
}
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function safeBaseName(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('-') || value.includes('..') || value.includes('@{')) return null;
  // eslint-disable-next-line no-control-regex -- unsafe Git ref/revision bytes
  return /[\s~^:?*[\]\\\u0000-\u001f\u007f]/.test(value) ? null : value;
}

export function createGitStateHub({ onChange, mutations = hostMutationCoordinator, authorizeTarget } = {}) {
  const targets = new Map(); // cwd → target
  const negatives = new Map(); // non-git path → checkedAt
  const repos = new Map(); // mainRoot → { cwds:Set, nextFetchAt, fetching }
  const emit = (snapshot) => {
    if (disposed || typeof onChange !== 'function') return;
    try {
      onChange(snapshot);
    } catch {
      /* listener faults must not break the hub */
    }
  };

  let disposed = false;
  let epoch = 0;
  const lifecycle = new AbortController();
  const inflight = new Set();
  const isLive = (target, token) => !disposed
    && token === epoch
    && !target.disposed
    && targets.get(target.cwd) === target;
  const reauthorize = async (target, token) => {
    if (!isLive(target, token)) return null;
    if (typeof authorizeTarget !== 'function') return { cwd: target.cwd, identity: target.capability };
    const current = await authorizeTarget(target.cwd);
    if (!isLive(target, token)
      || !current?.ok
      || current.gitBoundary !== 'root'
      || current.cwd !== target.cwd
      || current.mainRepoRoot !== target.mainRoot
      || current.identity?.dev !== target.capability?.dev
      || current.identity?.ino !== target.capability?.ino
      || current.mainIdentity?.dev !== target.capability?.mainDev
      || current.mainIdentity?.ino !== target.capability?.mainIno) {
      if (isLive(target, token)) disposeTarget(target);
      return null;
    }
    return current;
  };
  const track = (promise) => {
    inflight.add(promise);
    promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    );
    return promise;
  };

  /* ---------------- target lifecycle ---------------- */

  async function ensureTarget(cwd) {
    if (disposed || !cwd) return null;
    const existing = targets.get(cwd);
    if (existing) {
      if (typeof authorizeTarget === 'function') {
        const current = await authorizeTarget(cwd);
        if (disposed) return null;
        if (!current?.ok
          || current.gitBoundary !== 'root'
          || current.mainRepoRoot !== existing.mainRoot
          || current.identity?.dev !== existing.capability?.dev
          || current.identity?.ino !== existing.capability?.ino
          || current.mainIdentity?.dev !== existing.capability?.mainDev
          || current.mainIdentity?.ino !== existing.capability?.mainIno) {
          disposeTarget(existing);
          return null;
        }
      }
      existing.lastAccess = Date.now();
      return existing;
    }
    const neg = negatives.get(cwd);
    if (neg && Date.now() - neg < NEGATIVE_TTL_MS) return null;
    const token = epoch;
    const capability = typeof authorizeTarget === 'function' ? await authorizeTarget(cwd) : null;
    if (disposed || token !== epoch) return null;
    if (typeof authorizeTarget === 'function'
      && (!capability?.ok || capability.gitBoundary !== 'root' || capability.cwd !== cwd)) return null;
    const detect = await detectRepo(cwd);
    if (disposed || token !== epoch) return null;
    if (typeof authorizeTarget === 'function') {
      const confirmed = await authorizeTarget(cwd);
      if (disposed || token !== epoch
        || !confirmed?.ok
        || confirmed.gitBoundary !== 'root'
        || confirmed.mainRepoRoot !== capability.mainRepoRoot
        || confirmed.identity?.dev !== capability.identity?.dev
        || confirmed.identity?.ino !== capability.identity?.ino
        || confirmed.mainIdentity?.dev !== capability.mainIdentity?.dev
        || confirmed.mainIdentity?.ino !== capability.mainIdentity?.ino) return null;
    }
    const raced = targets.get(cwd);
    if (raced) {
      raced.lastAccess = Date.now();
      return raced;
    }
    if (!detect.isGit
      || (capability && capability.mainRepoRoot !== detect.mainRepoRoot)) {
      negatives.set(cwd, Date.now());
      return null;
    }
    const target = {
      cwd,
      repoRoot: detect.repoRoot,
      mainRoot: detect.mainRepoRoot,
      gitCommonDir: detect.gitCommonDir,
      isLinkedWorktree: detect.isLinkedWorktree,
      capability: capability ? {
        mainRepoRoot: capability.mainRepoRoot,
        dev: capability.identity?.dev,
        ino: capability.identity?.ino,
        mainDev: capability.mainIdentity?.dev,
        mainIno: capability.mainIdentity?.ino,
      } : null,
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
    const token = epoch;
    const promise = (async () => {
      const authorized = await reauthorize(target, token);
      if (!authorized) return null;
      let directory = null;
      let mainDirectory = null;
      try {
        let cwd = target.cwd;
        if (typeof authorizeTarget === 'function') {
          directory = await open(target.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const identity = await directory.stat();
          if (identity.dev !== authorized.identity?.dev || identity.ino !== authorized.identity?.ino) {
            disposeTarget(target);
            return null;
          }
          if (authorized.mainRepoRoot && authorized.mainRepoRoot !== authorized.cwd) {
            mainDirectory = await open(authorized.mainRepoRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            const mainIdentity = await mainDirectory.stat();
            if (mainIdentity.dev !== authorized.mainIdentity?.dev || mainIdentity.ino !== authorized.mainIdentity?.ino) {
              disposeTarget(target);
              return null;
            }
          }
          cwd = `/proc/self/fd/${directory.fd}`;
        }
      const [branchInfo, status, metadata, defaultBranch] = await Promise.all([
        currentBranchInfo(cwd),
        porcelainStatus(cwd),
        readMetadata(cwd).catch(() => null),
        resolveDefaultBranch(cwd),
      ]);
      if (!isLive(target, token)) return target.snapshot;
      const branch = branchInfo.branch;
      const metadataBaseName = safeBaseName(metadata?.baseRefName);
      const baseName = metadataBaseName || safeBaseName(defaultBranch);
      const bestBase = baseName ? await resolveBestComparisonBaseRef(cwd, baseName) : null;
      if (!isLive(target, token)) return target.snapshot;
      // A display branch can move or disappear. Only a typed immutable commit
      // may be the metadata fallback; raw metadata never becomes a Git option.
      const immutableBase = FULL_OID.test(metadata?.baseRef || '') ? metadata.baseRef : null;
      const comparisonBase = bestBase || immutableBase;
      const [abResult, upstream, remote] = await Promise.all([
        comparisonBase
          ? aheadBehind(cwd, comparisonBase)
          : Promise.resolve(branchInfo.ok
            ? { ok: true, ahead: 0, behind: 0 }
            : { ok: false, ahead: null, behind: null, error: branchInfo.error || 'cannot resolve HEAD' }),
        branch ? upstreamInfo(cwd, branch) : Promise.resolve({ upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 }),
        originUrl(cwd),
      ]);
      if (!isLive(target, token)) return target.snapshot;
      const originDeltaResult = branch && !upstream.upstreamRef ? await originBranchDelta(cwd, branch) : null;
      if (!isLive(target, token)) return target.snapshot;
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
      if (!isLive(target, token)) return target.snapshot;
      if (!statResult.ok) degraded.push({ stage: 'diff-stat', message: statResult.error || 'git diff failed' });
      const ab = abResult.ok
        ? { ahead: abResult.ahead, behind: abResult.behind }
        : null;
      const stat = statResult.ok
        ? { additions: statResult.additions, deletions: statResult.deletions, files: statResult.files }
        : target.snapshot?.diffStat ?? null;
      const managed = metadata ? (await validateManagedWorktree(cwd)).ok : false;
      if (!isLive(target, token)) return target.snapshot;
      const originIdentity = await forgeIdentityForCwd(cwd) || parseGithubRemote(remote);
      if (!isLive(target, token)) return target.snapshot;
      const pullProvenanceValid = validPullProvenance(metadata);
      const pullProvenanceMalformed = metadata?.intent === 'pr-checkout' && !pullProvenanceValid;
      const pullIdentity = pullProvenanceValid
        ? { host: metadata.pullHost, owner: metadata.pullOwner, repo: metadata.pullRepo }
        : null;
      const upstreamIdentity = pullIdentity ? parseGithubRemote(await remoteUrl(cwd, 'upstream').catch(() => null)) : null;
      const pullKey = forgeRepositoryKey(pullIdentity);
      const pullIdentityTrusted = Boolean(pullIdentity && pullKey && managed && [originIdentity, upstreamIdentity]
        .some((identity) => forgeRepositoryKey(identity) === pullKey));
      // Older PR metadata has no repository identity. A number plus commit SHA
      // cannot bind a repository (forks share objects), so remote status and
      // destructive actions stay disabled until the worktree is recreated.
      const legacyPullProbe = false;
      const unsafePullIdentity = pullProvenanceMalformed || (pullProvenanceValid && !pullIdentityTrusted);
      const github = pullIdentityTrusted ? pullIdentity : originIdentity;
      let forgeAuth = 'no_remote';
      if (github) {
        if (!(await ghAvailable())) forgeAuth = 'cli_missing';
        else {
          if (!isLive(target, token)) return target.snapshot;
          forgeAuth = (await ghAuthenticated(github.host)) ? 'ok' : 'unauthenticated';
        }
      }
      if (!isLive(target, token)) return target.snapshot;
      const statusEntries = status.ok ? status.entries : null;
      const untrackedCount = statusEntries
        ? statusEntries.filter((entry) => entry.code === '??').length
        : target.snapshot?.untrackedCount ?? null;
      let pr = unsafePullIdentity ? null : target.snapshot?.pr ?? null;
      let fetchedPr = false;
      // first compute fetches PR inline so the badge appears without waiting for the poll grid
      if (!unsafePullIdentity && !target.snapshot && github && branch && forgeAuth === 'ok') {
        try {
          const result = await prStatusBatch([
            { key: cwd, host: github.host, owner: github.owner, repo: github.repo, pullNumber: pullIdentityTrusted ? metadata.pullNumber : undefined, headRef: pullIdentityTrusted ? metadata.pullHeadRef : branch, headSha: branchInfo.sha },
          ]);
          if (!isLive(target, token)) return target.snapshot;
          pr = result.get(cwd)?.pr ?? null;
          fetchedPr = true;
          if (pullIdentityTrusted && pr?.number !== metadata.pullNumber) pr = null;
          target.nextPrAt = Date.now() + (pr?.checks?.status === 'pending' ? PR_PENDING_MS : PR_IDLE_MS);
        } catch {
          /* poll loop retries */
        }
      }
      if (!isLive(target, token)) return target.snapshot;
      if (!(await reauthorize(target, token))) return null;
      // A background PR poll may have committed while this slower filesystem
      // compute was in flight. Preserve it only when both operations addressed
      // the exact same repository/number-or-head/SHA selector.
      const nextPrSelector = prSelectorKey({
        github,
        prNumber: (pullIdentityTrusted || legacyPullProbe) && Number.isSafeInteger(metadata?.pullNumber) ? metadata.pullNumber : null,
        prHeadRef: pullIdentityTrusted || legacyPullProbe ? metadata?.pullHeadRef ?? null : null,
        branch,
        prLookupSha: legacyPullProbe ? metadata.prHeadSha : branchInfo.sha ?? null,
        sha: branchInfo.sha,
        prPollingDisabled: unsafePullIdentity,
      });
      if (!fetchedPr && !unsafePullIdentity && target.snapshot
        && prSelectorKey(target.snapshot) === nextPrSelector) pr = target.snapshot.pr ?? null;
      else if (!fetchedPr && prSelectorKey(target.snapshot) !== nextPrSelector) {
        pr = null;
        target.nextPrAt = 0;
      }
      const snapshot = {
        cwd: target.cwd,
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
        prHeadRef: pullIdentityTrusted || legacyPullProbe ? metadata?.pullHeadRef ?? null : null,
        prNumber: (pullIdentityTrusted || legacyPullProbe) && Number.isSafeInteger(metadata?.pullNumber) ? metadata.pullNumber : null,
        prLookupSha: legacyPullProbe ? metadata.prHeadSha : branchInfo.sha ?? null,
        prRequireShaMatch: legacyPullProbe,
        prPollingDisabled: unsafePullIdentity,
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
      } finally {
        await mainDirectory?.close().catch(() => {});
        await directory?.close().catch(() => {});
      }
    })().finally(() => {
      target.computing = null;
    });
    target.computing = track(promise);
    return target.computing;
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
      const token = epoch;
      repo.nextFetchAt = now + FETCH_INTERVAL_MS;
      if (disposed || token !== epoch) continue;
      repo.fetching = true;
      const fetchTask = mutations.run(`git:${mainRoot}`, async () => {
        if (disposed || token !== epoch || repos.get(mainRoot) !== repo) return null;
        let authorizedCapability = null;
        if (typeof authorizeTarget === 'function') {
          for (const cwd of repo.cwds) {
            const target = targets.get(cwd);
            if (!target) continue;
            const current = await authorizeTarget(cwd);
            if (disposed || token !== epoch || repos.get(mainRoot) !== repo) return null;
            if (current?.ok
              && current.gitBoundary === 'root'
              && current.cwd === cwd
              && current.mainRepoRoot === mainRoot
              && current.identity?.dev === target.capability?.dev
              && current.identity?.ino === target.capability?.ino
              && current.mainIdentity?.dev === target.capability?.mainDev
              && current.mainIdentity?.ino === target.capability?.mainIno) {
              authorizedCapability = current;
              break;
            }
            disposeTarget(target);
          }
          if (!authorizedCapability) return null;
        }
        let directory = null;
        let mainDirectory = null;
        try {
          let stableCwd = mainRoot;
          if (authorizedCapability) {
            directory = await open(authorizedCapability.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            const identity = await directory.stat();
            if (identity.dev !== authorizedCapability.identity.dev || identity.ino !== authorizedCapability.identity.ino) return null;
            if (authorizedCapability.mainRepoRoot !== authorizedCapability.cwd) {
              mainDirectory = await open(authorizedCapability.mainRepoRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
              const mainIdentity = await mainDirectory.stat();
              if (mainIdentity.dev !== authorizedCapability.mainIdentity?.dev
                || mainIdentity.ino !== authorizedCapability.mainIdentity?.ino) return null;
            }
            stableCwd = `/proc/self/fd/${directory.fd}`;
          }
          if (repo.hasOrigin === null) repo.hasOrigin = Boolean(await originUrl(stableCwd));
          if (!repo.hasOrigin || disposed || token !== epoch) return null;
          return await runGit(['fetch', 'origin', '--prune'], { cwd: stableCwd, timeout: 120000 });
        } finally {
          await mainDirectory?.close().catch(() => {});
          await directory?.close().catch(() => {});
        }
      }, { signal: lifecycle.signal })
        .then((fetchResult) => {
          if (!fetchResult?.ok || disposed || token !== epoch || repos.get(mainRoot) !== repo) return;
          for (const cwd of repo.cwds) {
            const target = targets.get(cwd);
            if (target) scheduleCompute(target, WATCH_DEBOUNCE_MS, true);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (repos.get(mainRoot) === repo) repo.fetching = false;
        });
      track(fetchTask);
    }
  }

  /* ---------------- adaptive PR/checks poll ---------------- */

  async function runDuePrPolls() {
    const token = epoch;
    const now = Date.now();
    const due = [];
    for (const target of targets.values()) {
      const s = target.snapshot;
      if (!s || !s.github || !s.branch || s.forgeAuth !== 'ok' || s.prPollingDisabled) continue;
      if (now < target.nextPrAt) continue;
      due.push(target);
    }
    if (due.length === 0) return;
    const authorizedDue = [];
    for (const target of due) {
      if (typeof authorizeTarget !== 'function') {
        authorizedDue.push(target);
        continue;
      }
      if (await reauthorize(target, token)) authorizedDue.push(target);
    }
    if (authorizedDue.length === 0) return;
    const pollingTargets = authorizedDue.slice(0, 20);
    const selectors = new Map(pollingTargets.map((t) => [t.cwd, prSelectorKey(t.snapshot)]));
    const batch = pollingTargets.map((t) => ({
      key: t.cwd,
      host: t.snapshot.github.host,
      owner: t.snapshot.github.owner,
      repo: t.snapshot.github.repo,
      pullNumber: t.snapshot.prNumber,
      headRef: t.snapshot.prHeadRef || t.snapshot.branch,
      headSha: t.snapshot.prLookupSha || t.snapshot.sha,
    }));
    let results;
    try {
      results = await prStatusBatch(batch);
    } catch {
      if (disposed || token !== epoch) return;
      for (const t of pollingTargets) {
        if (!(await reauthorize(t, token))) continue;
        if (selectors.get(t.cwd) !== prSelectorKey(t.snapshot)) continue;
        t.prBackoffMs = Math.min(Math.max(t.prBackoffMs * 2, PR_PENDING_MS), PR_BACKOFF_CAP_MS);
        t.nextPrAt = Date.now() + t.prBackoffMs;
      }
      return;
    }
    if (disposed || token !== epoch) return;
    for (const t of pollingTargets) {
      if (t.disposed || targets.get(t.cwd) !== t) continue;
      if (!(await reauthorize(t, token))) continue;
      if (selectors.get(t.cwd) !== prSelectorKey(t.snapshot)) continue;
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
      let pr = value.pr ?? null;
      if (Number.isSafeInteger(t.snapshot.prNumber)
        && (pr?.number !== t.snapshot.prNumber || (t.snapshot.prRequireShaMatch && pr?.headShaMatches !== true))) pr = null;
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
    track(runDueFetches().catch(() => {}));
    track(runDuePrPolls().catch(() => {}));
  }, TICK_MS);
  const pruneTimer = setInterval(() => {
    if (!disposed) pruneStale();
  }, 60000);

  /* ---------------- public face ---------------- */

  let lastGlobalRefresh = 0;
  return {
    /** Fresh snapshot for one cwd (computes on demand, 3 s cache; `fresh:true` skips the cache). */
    async snapshotFor(cwd, opts = {}) {
      const target = await track(ensureTarget(cwd));
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
      const target = await track(ensureTarget(cwd));
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
      if (disposed) {
        await Promise.allSettled([...inflight]);
        return;
      }
      disposed = true;
      epoch += 1;
      lifecycle.abort();
      clearInterval(tickTimer);
      clearInterval(pruneTimer);
      for (const target of [...targets.values()]) disposeTarget(target);
      targets.clear();
      repos.clear();
      await Promise.allSettled([...inflight]);
    },
  };
}

export { mainRepoRootOf };
