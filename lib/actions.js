/**
 * actions.js — the executable half of the diff view: commit / pull / push /
 * discard / merge-to-base / update-from-base / create-PR / merge-PR /
 * auto-merge / archive, plus the paseo-style action ladder (primary action
 * promoted by state priority; every disabled action carries a precise reason
 * key the client localizes).
 */
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import {
  aheadBehind,
  currentBranchInfo,
  headState,
  listCommits,
  listWorktreesRaw,
  originUrl,
  porcelainStatus,
  resolveBestComparisonBaseRef,
  resolveDefaultBranch,
  runGit,
  safeRealpath,
  upstreamInfo,
} from './git.js';
import { archiveWorktree, mainRepoRootOf, readMetadata } from './worktree.js';
import {
  createPullRequest,
  disableAutoMerge,
  invalidateForgeList,
  invalidatePr,
  mergePullRequest,
  parseGithubRemote,
  prStatus,
} from './forge.js';
import { resolveDiffRefs } from './diff.js';

const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function safeBaseName(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('-') || value.includes('..') || value.includes('@{')) return null;
  // eslint-disable-next-line no-control-regex -- unsafe Git ref/revision bytes
  return /[\s~^:?*[\]\\\u0000-\u001f\u007f]/.test(value) ? null : value;
}

async function contextOf(cwd) {
  const branchInfo = await currentBranchInfo(cwd);
  const metadata = await readMetadata(cwd).catch(() => null);
  const defaultBranch = safeBaseName(await resolveDefaultBranch(cwd));
  const baseName = safeBaseName(metadata?.baseRefName) || defaultBranch;
  const bestBase = baseName ? await resolveBestComparisonBaseRef(cwd, baseName) : null;
  const upstream = branchInfo.branch ? await upstreamInfo(cwd, branchInfo.branch) : { upstreamRef: null, aheadOfOrigin: 0, behindOfOrigin: 0 };
  const remote = await originUrl(cwd);
  const github = parseGithubRemote(remote);
  return { branchInfo, metadata, defaultBranch, baseName, bestBase, upstream, remote, github };
}

/* ------------------------------------------------------------------ */
/* mutations                                                           */
/* ------------------------------------------------------------------ */

function inspectionFailure(stage, result) {
  return {
    ok: false,
    reason: 'inspect-failed',
    stage,
    message: String(result?.error || result?.stderr || `${stage} failed`).trim().slice(0, 600),
  };
}

function compoundFailure(stages) {
  const failed = stages.filter((entry) => !entry.result.ok);
  if (failed.length === 0) return null;
  return {
    ok: false,
    partial: stages.some((entry) => entry.result.ok),
    stage: failed.map((entry) => entry.stage).join(','),
    message: failed.map((entry) => `${entry.stage}: ${entry.result.stderr || 'failed'}`).join('\n').trim().slice(0, 600),
  };
}

export async function commitAction(cwd, { message, addAll = true }) {
  if (!message || !message.trim()) return { ok: false, reasonKey: 'actions.commit.noMessage' };
  const [head, status] = await Promise.all([headState(cwd), porcelainStatus(cwd)]);
  if (!head.ok) return inspectionFailure('head', head);
  if (!status.ok) return inspectionFailure('status', status);
  if (!status.dirty) return { ok: false, reasonKey: 'actions.commit.clean' };
  if (addAll) {
    const add = await runGit(['add', '-A'], { cwd, timeout: 60000 });
    if (!add.ok) return { ok: false, message: add.stderr.trim() };
  }
  const r = await runGit(['commit', '-m', message], { cwd, timeout: 120000 });
  if (!r.ok) {
    return {
      ok: false,
      ...(addAll ? { partial: true, stage: 'commit', staged: true } : {}),
      message: (r.stderr || r.stdout).trim().slice(0, 600),
    };
  }
  return { ok: true };
}

export async function pullAction(cwd) {
  const [head, status, beforeMerge] = await Promise.all([
    headState(cwd),
    porcelainStatus(cwd),
    runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd }),
  ]);
  if (!head.ok) return inspectionFailure('head', head);
  if (!status.ok) return inspectionFailure('status', status);
  if (beforeMerge.ok) {
    return { ok: false, reason: 'merge-in-progress', message: 'resolve or abort the existing merge before pulling' };
  }
  if (beforeMerge.code !== 1) return inspectionFailure('merge-state', beforeMerge);
  if (status.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyCurrent' };

  // Pin merge mode so user/global pull.rebase cannot leave an unrecognized
  // rebase-merge state; the failure cleanup below has one explicit protocol.
  const r = await runGit(['pull', '--no-rebase'], { cwd, timeout: 120000 });
  if (!r.ok) {
    // A user/Agent can start resolving conflicts immediately after Git exits.
    // Without a cross-process lease there is no atomic ownership proof for an
    // automatic abort, so preserve every merge state for explicit recovery.
    const afterMerge = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
    return {
      ok: false,
      message: (r.stderr || r.stdout).trim().slice(0, 600),
      ...(afterMerge.ok
        ? { partial: true, stage: 'merge-conflict-preserved', recovery: 'resolve conflicts or run git merge --abort explicitly' }
        : {}),
    };
  }
  return { ok: true, output: r.stdout.trim().slice(0, 2000) };
}

export async function pushAction(cwd) {
  const branchInfo = await currentBranchInfo(cwd);
  if (!branchInfo.ok) return inspectionFailure('head', branchInfo);
  const { branch, unborn, detached } = branchInfo;
  if (!branch || unborn || detached) return { ok: false, reasonKey: 'actions.push.noBranch' };
  const upstream = await upstreamInfo(cwd, branch);
  const localRef = `refs/heads/${branch}`;
  const args = upstream.upstreamRef ? ['push'] : ['push', '-u', 'origin', `${localRef}:${localRef}`];
  const r = await runGit(args, { cwd, timeout: 180000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}

export async function fetchAction(cwd) {
  const r = await runGit(['fetch', 'origin', '--prune'], { cwd, timeout: 120000 });
  if (!r.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
  return { ok: true };
}

export async function discardAction(cwd, { paths = null } = {}) {
  let safe = null;
  if (Array.isArray(paths) && paths.length > 0) {
    const valid = paths.filter((path) => typeof path === 'string' && path !== '' && !path.startsWith('/')
      && !path.includes('\0') && !path.split('/').includes('..'));
    if (valid.length !== paths.length) return { ok: false, reasonKey: 'actions.discard.unsafePath' };
    safe = valid.map((path) => `:(literal)${path}`);
  }
  const head = await headState(cwd);
  if (!head.ok) return inspectionFailure('head', head);
  // A true unborn repository has no tracked state to reset. Cleaning its
  // untracked files is the complete requested operation, not a partial reset.
  if (head.unborn) {
    const clean = await runGit(safe ? ['clean', '-fd', '--', ...safe] : ['clean', '-fd'], { cwd, timeout: 60000 });
    return clean.ok ? { ok: true } : { ok: false, stage: 'clean', message: clean.stderr.trim().slice(0, 600) };
  }
  if (safe) {
    const reset = await runGit(['reset', '-q', '--', ...safe], { cwd });
    const checkout = await runGit(['checkout', '-q', '--', ...safe], { cwd });
    const clean = await runGit(['clean', '-fd', '--', ...safe], { cwd });
    return compoundFailure([
      { stage: 'reset', result: reset },
      { stage: 'checkout', result: checkout },
      { stage: 'clean', result: clean },
    ]) || { ok: true };
  }
  const reset = await runGit(['reset', '--hard', 'HEAD'], { cwd, timeout: 60000 });
  if (!reset.ok) return { ok: false, stage: 'reset', message: reset.stderr.trim().slice(0, 600) };
  const clean = await runGit(['clean', '-fd'], { cwd, timeout: 60000 });
  return clean.ok ? { ok: true } : { ok: false, partial: true, stage: 'clean', message: clean.stderr.trim().slice(0, 600) };
}

async function mergeWithOwnedRollback(cwd, target, expectedBranch) {
  const preMergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
  if (preMergeHead.ok) return { ok: false, reason: 'merge-in-progress', reasonKey: 'actions.merge.inProgress' };
  if (typeof preMergeHead.code !== 'number') return inspectionFailure('merge-head', preMergeHead);

  const [targetOid, preHead] = await Promise.all([
    runGit(['rev-parse', '--verify', `${target}^{commit}`], { cwd }),
    runGit(['rev-parse', '--verify', 'HEAD'], { cwd }),
  ]);
  if (!targetOid.ok || !FULL_OID.test(targetOid.stdout.trim())) return inspectionFailure('merge-target', targetOid);
  if (!preHead.ok || !FULL_OID.test(preHead.stdout.trim())) return inspectionFailure('pre-merge-head', preHead);
  const immutableTarget = targetOid.stdout.trim();
  const originalHead = preHead.stdout.trim();
  const branchBefore = await currentBranchInfo(cwd);
  if (!branchBefore.ok || branchBefore.branch !== expectedBranch) {
    return { ok: false, reason: 'stale-target', reasonKey: 'actions.merge.staleTarget' };
  }

  const merged = await runGit(['merge', '--no-edit', immutableTarget], { cwd, timeout: 120000 });
  if (merged.ok) {
    const [branchAfter, containsTarget] = await Promise.all([
      currentBranchInfo(cwd),
      runGit(['merge-base', '--is-ancestor', immutableTarget, 'HEAD'], { cwd }),
    ]);
    if (!branchAfter.ok || branchAfter.branch !== expectedBranch || !containsTarget.ok) {
      return { ok: false, partial: true, stage: 'merge-postcondition', message: 'merge completed but its target postcondition could not be proven' };
    }
    return { ok: true, mergedOid: immutableTarget };
  }

  const postMergeHead = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
  if (!postMergeHead.ok) {
    return { ok: false, stage: 'merge', message: merged.stderr.trim().slice(0, 600) };
  }
  if (postMergeHead.stdout.trim() !== immutableTarget) {
    return {
      ok: false,
      partial: true,
      stage: 'foreign-merge',
      message: 'merge failed while a non-owned MERGE_HEAD was present; refusing to abort it',
    };
  }
  const [branchDuringFailure, headDuringFailure] = await Promise.all([
    currentBranchInfo(cwd),
    runGit(['rev-parse', '--verify', 'HEAD'], { cwd }),
  ]);
  if (!branchDuringFailure.ok
    || branchDuringFailure.branch !== expectedBranch
    || !headDuringFailure.ok
    || headDuringFailure.stdout.trim() !== originalHead) {
    return {
      ok: false,
      partial: true,
      stage: 'merge-ownership-changed',
      message: 'owned MERGE_HEAD was present but branch/HEAD ownership changed; refusing to abort',
    };
  }

  const conflicts = await runGit(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd });
  return {
    ok: false,
    reasonKey: 'actions.merge.conflict',
    conflictFiles: conflicts.ok ? conflicts.stdout.split('\0').filter(Boolean) : [],
    partial: true,
    stage: 'merge-conflict-preserved',
    recovery: 'resolve conflicts or run git merge --abort explicitly',
  };
}

async function withTargetDirfd(target, task) {
  if (process.platform !== 'linux') return { ok: false, status: 503, reason: 'stable-target-unavailable' };
  let handle;
  let mainHandle;
  try {
    handle = await open(target.cwd, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = await handle.stat();
    if (identity.dev !== target.identity?.dev || identity.ino !== target.identity?.ino) {
      return { ok: false, status: 409, reason: 'stale-target' };
    }
    if (target.mainRepoRoot && target.mainRepoRoot !== target.cwd) {
      mainHandle = await open(target.mainRepoRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const mainIdentity = await mainHandle.stat();
      if (mainIdentity.dev !== target.mainIdentity?.dev || mainIdentity.ino !== target.mainIdentity?.ino) {
        return { ok: false, status: 409, reason: 'stale-target' };
      }
    }
    return await task(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    return { ok: false, status: 409, reason: 'stale-target', message: String(error?.message ?? error) };
  } finally {
    await mainHandle?.close().catch(() => {});
    await handle?.close().catch(() => {});
  }
}

/**
 * Merge the current branch INTO the base branch. v1 deviation from paseo
 * (documented in the diff view): we only merge when the base branch is
 * checked out in some worktree, and merge THERE — we never switch the
 * current worktree's branch (worktrees are pinned, see ADR 0002).
 */
export async function mergeToBaseAction(cwd, { authorizeTarget, sourceMainRoot, sourceMainIdentity } = {}) {
  const { branchInfo, baseName } = await contextOf(cwd);
  if (!branchInfo.ok) return inspectionFailure('head', branchInfo);
  if (!branchInfo.branch) return { ok: false, reasonKey: 'actions.merge.detached' };
  if (!baseName || branchInfo.branch === baseName) return { ok: false, reasonKey: 'actions.mergeToBase.onBase' };
  const mainRoot = await mainRepoRootOf(cwd);
  const canonicalMain = await safeRealpath(mainRoot);
  const expectedMain = sourceMainRoot ? await safeRealpath(sourceMainRoot) : canonicalMain;
  if (!canonicalMain || canonicalMain !== expectedMain) return { ok: false, status: 409, reason: 'stale-target' };
  const worktrees = await listWorktreesRaw(canonicalMain);
  const owner = worktrees.find((item) => item.branch === baseName && !item.bare && !item.prunable);
  if (!owner) return { ok: false, reasonKey: 'actions.mergeToBase.noOwner' };

  const ownerPath = await safeRealpath(owner.path);
  if (!ownerPath) return { ok: false, status: 409, reason: 'stale-target' };
  // ADR 0010: the exact main checkout is the one deliberate server-derived
  // cross-root target; every other linked owner needs independent authority.
  const ownerIsMain = ownerPath === canonicalMain;
  let targetAuth;
  if (ownerIsMain) {
    const identity = await stat(ownerPath);
    if (sourceMainIdentity
      && (identity.dev !== sourceMainIdentity.dev || identity.ino !== sourceMainIdentity.ino)) {
      return { ok: false, status: 409, reason: 'stale-target' };
    }
    targetAuth = {
      ok: true,
      cwd: ownerPath,
      mainRepoRoot: canonicalMain,
      gitBoundary: 'root',
      identity: { dev: identity.dev, ino: identity.ino },
      mainIdentity: { dev: identity.dev, ino: identity.ino },
    };
  } else {
    targetAuth = authorizeTarget ? await authorizeTarget(ownerPath) : null;
    if (!targetAuth?.ok
      || targetAuth.gitBoundary !== 'root'
      || targetAuth.cwd !== ownerPath
      || targetAuth.mainRepoRoot !== canonicalMain
      || (sourceMainIdentity && (
        targetAuth.mainIdentity?.dev !== sourceMainIdentity.dev
        || targetAuth.mainIdentity?.ino !== sourceMainIdentity.ino
      ))) {
      return {
        ok: false,
        status: 403,
        reason: 'target-unauthorized',
        reasonKey: 'actions.mergeToBase.targetUnauthorized',
        message: 'base worktree is outside the authorized repository family',
      };
    }
  }

  const ownStatus = await porcelainStatus(cwd);
  if (!ownStatus.ok) return inspectionFailure('current-status', ownStatus);
  if (ownStatus.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyCurrent' };
  return withTargetDirfd(targetAuth, async (stableOwner) => {
    const ownerMain = await safeRealpath(await mainRepoRootOf(stableOwner));
    const ownerBranch = await currentBranchInfo(stableOwner);
    if (ownerMain !== canonicalMain || !ownerBranch.ok || ownerBranch.branch !== baseName) {
      return { ok: false, status: 409, reason: 'stale-target' };
    }
    const ownerStatus = await porcelainStatus(stableOwner);
    if (!ownerStatus.ok) return inspectionFailure('owner-status', ownerStatus);
    if (ownerStatus.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyOwner' };
    const merged = await mergeWithOwnedRollback(stableOwner, `refs/heads/${branchInfo.branch}`, baseName);
    return { ...merged, mergedInto: ownerPath, ...(!merged.ok ? { recoveryCwd: ownerPath } : {}) };
  });
}

/** Merge the freshest base INTO the current branch (requires a clean tree — paseo). */
export async function updateFromBaseAction(cwd) {
  const { branchInfo, baseName, bestBase } = await contextOf(cwd);
  if (!branchInfo.ok) return inspectionFailure('head', branchInfo);
  if (!branchInfo.branch) return { ok: false, reasonKey: 'actions.merge.detached' };
  if (!bestBase) return { ok: false, reasonKey: 'actions.updateFromBase.noBase' };
  const status = await porcelainStatus(cwd);
  if (!status.ok) return inspectionFailure('status', status);
  if (status.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyCurrent' };
  const delta = await aheadBehind(cwd, bestBase);
  if (!delta.ok) return inspectionFailure('ahead-behind', delta);
  if (delta.behind === 0) return { ok: false, reasonKey: 'actions.updateFromBase.upToDate' };
  return mergeWithOwnedRollback(cwd, bestBase, branchInfo.branch);
}

export async function createPrAction(cwd, { title, body, draft = false } = {}) {
  const { branchInfo, baseName, bestBase, github } = await contextOf(cwd);
  if (!branchInfo.ok) return inspectionFailure('head', branchInfo);
  if (!github) return { ok: false, reasonKey: 'actions.pr.notGithub' };
  if (!branchInfo.branch || branchInfo.unborn || branchInfo.detached) return { ok: false, reasonKey: 'actions.push.noBranch' };
  // ensure the branch exists on origin and is pushed (paseo: push -u origin head first)
  const push = await runGit(
    (await upstreamInfo(cwd, branchInfo.branch)).upstreamRef
      ? ['push']
      : ['push', '-u', 'origin', `refs/heads/${branchInfo.branch}:refs/heads/${branchInfo.branch}`],
    { cwd, timeout: 180000 },
  );
  if (!push.ok) return { ok: false, message: (push.stderr || push.stdout).trim().slice(0, 600) };
  const base = baseName || 'main';
  let finalTitle = title && title.trim() ? title.trim() : null;
  let finalBody = body ?? null;
  if (!finalTitle || finalBody === null) {
    const refs = await resolveDiffRefs(cwd, { mode: 'base' });
    const commitResult = await listCommits(cwd, `${refs.baseRef}..HEAD`, 50);
    if (!commitResult.ok) return { ...inspectionFailure('commits', commitResult), partial: true, pushed: true };
    const commits = commitResult.commits;
    if (!finalTitle) finalTitle = commits[0]?.subject || branchInfo.branch;
    if (finalBody === null) {
      finalBody = commits.length
        ? commits.map((commitItem) => `- ${commitItem.subject} (\`${commitItem.short}\`)`).join('\n')
        : '';
    }
  }
  const r = await createPullRequest({
    owner: github.owner,
    repo: github.repo,
    base,
    head: branchInfo.branch,
    title: finalTitle,
    body: finalBody,
    draft,
  });
  if (!r.ok) return { ok: false, message: r.message };
  invalidatePr(`${github.owner}/${github.repo}@${branchInfo.branch}`);
  // the new PR belongs in the picker's next page, not in the cached one —
  // invalidation is per-cwd and the plugin knows no owner/repo there
  invalidateForgeList(cwd);
  return { ok: true, url: r.url };
}

export async function mergePrAction(cwd, { method = 'squash', auto = false } = {}) {
  const { branchInfo, github } = await contextOf(cwd);
  if (!github) return { ok: false, reasonKey: 'actions.pr.notGithub' };
  if (!branchInfo.branch) return { ok: false, reasonKey: 'actions.push.noBranch' };
  const { pr } = await prStatus({
    owner: github.owner,
    repo: github.repo,
    headRef: branchInfo.branch,
    headSha: branchInfo.sha,
  });
  if (!pr) return { ok: false, reasonKey: 'actions.mergePr.noPr' };
  if (pr.state !== 'open') return { ok: false, reasonKey: 'actions.mergePr.notOpen' };
  const r = await mergePullRequest({ owner: github.owner, repo: github.repo, number: pr.number, method, auto });
  if (!r.ok) return { ok: false, message: r.message };
  invalidatePr(`${github.owner}/${github.repo}@${branchInfo.branch}`);
  return { ok: true };
}

export async function autoMergeOffAction(cwd) {
  const { branchInfo, github } = await contextOf(cwd);
  if (!github || !branchInfo.branch) return { ok: false, reasonKey: 'actions.pr.notGithub' };
  const { pr } = await prStatus({
    owner: github.owner,
    repo: github.repo,
    headRef: branchInfo.branch,
    headSha: branchInfo.sha,
  });
  if (!pr) return { ok: false, reasonKey: 'actions.mergePr.noPr' };
  const r = await disableAutoMerge({ owner: github.owner, repo: github.repo, number: pr.number });
  if (!r.ok) return { ok: false, message: r.message };
  invalidatePr(`${github.owner}/${github.repo}@${branchInfo.branch}`);
  return { ok: true };
}

export async function archiveAction(path, { force = false } = {}) {
  return archiveWorktree(path, { force });
}

/* ------------------------------------------------------------------ */
/* action ladder                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build the ladder from a snapshot (state.js shape). First ENABLED entry in
 * priority order is the primary button; the rest go to the overflow menu.
 * `agentRunning` disables every mutation (UI-side race guard, Q3 decision).
 */
export function buildActionLadder(snapshot, { agentRunning = false } = {}) {
  const entries = [];
  const s = snapshot ?? {};
  const branch = s.branch ?? null;
  // Older synthetic snapshots omit gitKnown and remain compatible. A live
  // snapshot that explicitly marks a probe unknown must never enable a
  // mutation from stale display values.
  const headKnown = s.gitKnown?.head !== false;
  const statusKnown = s.gitKnown?.status !== false;
  const aheadKnown = s.gitKnown?.aheadBehind !== false;
  const originKnown = s.gitKnown?.originDelta !== false;
  const unpushed = s.upstream ? s.upstream.ahead : (originKnown && s.originDelta ? s.originDelta.ahead : null);
  const behindUpstream = s.upstream ? s.upstream.behind : (originKnown && s.originDelta ? s.originDelta.behind : 0);
  const pr = s.pr ?? null;
  const guard = (entry) => {
    if (!headKnown && !entry.readOnly) {
      entry.disabled = true;
      entry.reasonKey = 'actions.failed';
    } else if (agentRunning && !entry.readOnly) {
      entry.disabled = true;
      entry.reasonKey = 'actions.disabled.agentRunning';
    }
    return entry;
  };

  entries.push(
    guard({
      id: 'commit',
      disabled: !statusKnown || s.dirty !== true,
      reasonKey: !statusKnown ? 'actions.failed' : s.dirty ? null : 'actions.commit.clean',
    }),
    guard({
      id: 'pull',
      disabled: !headKnown || !statusKnown || s.dirty !== false || !s.remote || behindUpstream === 0,
      reasonKey: !headKnown || !statusKnown
        ? 'actions.failed'
        : s.dirty
          ? 'actions.merge.dirtyCurrent'
          : !s.remote
            ? 'actions.pull.noRemote'
            : behindUpstream === 0
              ? 'actions.pull.upToDate'
              : null,
      params: { behind: behindUpstream },
    }),
    guard({
      id: 'push',
      disabled: !s.remote || !branch || !(unpushed > 0),
      reasonKey: !s.remote
        ? 'actions.push.noRemote'
        : !branch
          ? 'actions.push.noBranch'
          : !(unpushed > 0)
            ? 'actions.push.nothing'
            : null,
      params: { ahead: unpushed ?? 0 },
    }),
  );

  if (pr && pr.state === 'open') {
    entries.push(
      guard({
        id: 'mergePr',
        disabled: pr.isDraft || pr.mergeable === 'CONFLICTING',
        reasonKey: pr.isDraft ? 'actions.mergePr.draft' : pr.mergeable === 'CONFLICTING' ? 'actions.mergePr.conflicting' : null,
        params: { number: pr.number },
      }),
      { id: 'openPr', kind: 'link', url: pr.url, params: { number: pr.number } },
    );
  } else if (s.github && branch && aheadKnown && (s.aheadBehind?.ahead ?? 0) > 0) {
    entries.push(
      guard({
        id: 'createPr',
        disabled: false,
        reasonKey: null,
      }),
    );
  }

  entries.push(
    guard({
      id: 'mergeToBase',
      disabled: !statusKnown || !aheadKnown || s.dirty !== false || (s.aheadBehind?.ahead ?? 0) === 0,
      reasonKey: !statusKnown || !aheadKnown
        ? 'actions.failed'
        : s.dirty
          ? 'actions.merge.dirtyCurrent'
          : (s.aheadBehind?.ahead ?? 0) === 0
            ? 'actions.mergeToBase.nothing'
            : null,
    }),
    guard({
      id: 'updateFromBase',
      disabled: !statusKnown || !aheadKnown || s.dirty !== false || (s.aheadBehind?.behind ?? 0) === 0,
      reasonKey: !statusKnown || !aheadKnown
        ? 'actions.failed'
        : s.dirty
          ? 'actions.merge.dirtyCurrent'
          : (s.aheadBehind?.behind ?? 0) === 0
            ? 'actions.updateFromBase.upToDate'
            : null,
    }),
    guard({
      id: 'discard',
      disabled: !statusKnown || s.dirty !== true,
      reasonKey: !statusKnown ? 'actions.failed' : s.dirty ? null : 'actions.commit.clean',
    }),
    { id: 'fetch', readOnly: true, disabled: !s.remote, reasonKey: s.remote ? null : 'actions.pull.noRemote' },
    guard({
      id: 'archive',
      disabled: !s.managed || !headKnown || !statusKnown || !aheadKnown,
      reasonKey: !s.managed ? 'actions.archive.notManaged' : !headKnown || !statusKnown || !aheadKnown ? 'actions.failed' : null,
      warn: s.dirty || (unpushed ?? 0) > 0,
    }),
  );
  return entries.filter((e) => e.id !== 'mergeToBase' || branch !== s.baseRefName);
}

/** One dispatcher for POST /action. */
export async function executeAction(hub, cwd, actionName, params = {}, controls = {}) {
  let result;
  switch (actionName) {
    case 'commit':
      result = await commitAction(cwd, params);
      break;
    case 'pull':
      result = await pullAction(cwd);
      break;
    case 'push':
      result = await pushAction(cwd);
      break;
    case 'fetch':
      result = await fetchAction(cwd);
      break;
    case 'discard':
      result = await discardAction(cwd, params);
      break;
    case 'mergeToBase':
      result = await mergeToBaseAction(cwd, {
        authorizeTarget: controls.authorizeTarget,
        sourceMainRoot: controls.sourceMainRoot,
        sourceMainIdentity: controls.sourceMainIdentity,
      });
      break;
    case 'updateFromBase':
      result = await updateFromBaseAction(cwd);
      break;
    case 'createPr':
      result = await createPrAction(cwd, params);
      break;
    case 'mergePr':
      result = await mergePrAction(cwd, params);
      break;
    case 'autoMergeOff':
      result = await autoMergeOffAction(cwd);
      break;
    case 'archive':
      result = await archiveAction(cwd, params);
      break;
    default:
      return { ok: false, reasonKey: 'actions.unknown', params: { name: actionName } };
  }
  // mutations funnel through a forced snapshot refresh (paseo's notifyGitMutation);
  // awaiting it means the action response already implies fresh state for callers
  if (!controls.skipInvalidate) {
    await hub?.invalidate(cwd);
    if (actionName === 'mergeToBase' && result?.ok && result.mergedInto) await hub?.invalidate(result.mergedInto);
  }
  return result ?? { ok: false, reasonKey: 'actions.unknown' };
}
