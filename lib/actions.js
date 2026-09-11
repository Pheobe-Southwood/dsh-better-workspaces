/**
 * actions.js — the executable half of the diff view: commit / pull / push /
 * discard / merge-to-base / update-from-base / create-PR / merge-PR /
 * auto-merge / archive, plus the paseo-style action ladder (primary action
 * promoted by state priority; every disabled action carries a precise reason
 * key the client localizes).
 */
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

async function contextOf(cwd) {
  const branchInfo = await currentBranchInfo(cwd);
  const metadata = await readMetadata(cwd).catch(() => null);
  const defaultBranch = await resolveDefaultBranch(cwd);
  const baseName = metadata?.baseRefName || defaultBranch;
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
    // Abort only a merge created by this pull attempt. Never destroy a merge
    // (or carefully resolved conflict files) that pre-dated the action.
    const afterMerge = await runGit(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { cwd });
    if (!afterMerge.ok) return { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 600) };
    const aborted = await runGit(['merge', '--abort'], { cwd });
    return {
      ok: false,
      message: (r.stderr || r.stdout).trim().slice(0, 600),
      ...(aborted.ok
        ? {}
        : { partial: true, stage: 'merge-abort', abortError: aborted.stderr.trim().slice(0, 600) }),
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
  const args = upstream.upstreamRef ? ['push'] : ['push', '-u', 'origin', branch];
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
    safe = paths.filter((path) => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('..'));
    if (safe.length !== paths.length) return { ok: false, reasonKey: 'actions.discard.unsafePath' };
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

/**
 * Merge the current branch INTO the base branch. v1 deviation from paseo
 * (documented in the diff view): we only merge when the base branch is
 * checked out in some worktree, and merge THERE — we never switch the
 * current worktree's branch (worktrees are pinned, see ADR 0002).
 */
export async function mergeToBaseAction(cwd) {
  const { branchInfo, baseName } = await contextOf(cwd);
  if (!branchInfo.ok) return inspectionFailure('head', branchInfo);
  if (!branchInfo.branch) return { ok: false, reasonKey: 'actions.merge.detached' };
  if (!baseName || branchInfo.branch === baseName) return { ok: false, reasonKey: 'actions.mergeToBase.onBase' };
  const mainRoot = await mainRepoRootOf(cwd);
  const worktrees = await listWorktreesRaw(mainRoot);
  const owner = worktrees.find((w) => w.branch === baseName && !w.bare);
  if (!owner) return { ok: false, reasonKey: 'actions.mergeToBase.noOwner' };
  const ownStatus = await porcelainStatus(cwd);
  if (!ownStatus.ok) return inspectionFailure('current-status', ownStatus);
  if (ownStatus.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyCurrent' };
  const ownerStatus = await porcelainStatus(owner.path);
  if (!ownerStatus.ok) return inspectionFailure('owner-status', ownerStatus);
  if (ownerStatus.dirty) return { ok: false, reasonKey: 'actions.merge.dirtyOwner' };
  const r = await runGit(['merge', '--no-edit', branchInfo.branch], { cwd: owner.path, timeout: 120000 });
  if (!r.ok) {
    const conflicts = await runGit(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd: owner.path });
    const aborted = await runGit(['merge', '--abort'], { cwd: owner.path });
    const conflictFiles = conflicts.ok ? conflicts.stdout.split('\0').filter(Boolean) : [];
    return {
      ok: false,
      reasonKey: 'actions.merge.conflict',
      conflictFiles,
      ...(aborted.ok ? {} : { partial: true, stage: 'merge-abort', message: aborted.stderr.trim().slice(0, 600) }),
    };
  }
  return { ok: true, mergedInto: owner.path };
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
  const r = await runGit(['merge', '--no-edit', bestBase], { cwd, timeout: 120000 });
  if (!r.ok) {
    const conflicts = await runGit(['diff', '--name-only', '-z', '--diff-filter=U'], { cwd });
    const aborted = await runGit(['merge', '--abort'], { cwd });
    const conflictFiles = conflicts.ok ? conflicts.stdout.split('\0').filter(Boolean) : [];
    return {
      ok: false,
      reasonKey: 'actions.merge.conflict',
      conflictFiles,
      ...(aborted.ok ? {} : { partial: true, stage: 'merge-abort', message: aborted.stderr.trim().slice(0, 600) }),
    };
  }
  return { ok: true };
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
      : ['push', '-u', 'origin', branchInfo.branch],
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
export async function executeAction(hub, cwd, actionName, params = {}) {
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
      result = await mergeToBaseAction(cwd);
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
      result = await archiveAction(params.path ?? cwd, params);
      break;
    default:
      return { ok: false, reasonKey: 'actions.unknown', params: { name: actionName } };
  }
  // mutations funnel through a forced snapshot refresh (paseo's notifyGitMutation);
  // awaiting it means the action response already implies fresh state for callers
  await hub?.invalidate(cwd);
  if (actionName === 'mergeToBase' && result?.ok && result.mergedInto) await hub?.invalidate(result.mergedInto);
  return result ?? { ok: false, reasonKey: 'actions.unknown' };
}
