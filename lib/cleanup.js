/**
 * cleanup.js — maintenance sweep for abandoned managed worktrees.
 *
 * Archives every managed worktree that is provably idle: clean working tree,
 * zero commits ahead of its recorded base, zero unpushed commits, and (when
 * the host sessions service is readable) not the cwd of any live session.
 * Optionally deletes the now-empty Workspace registry entry so the sidebar
 * loses its orphan row too.
 *
 * Exists because the pre-amendment hero flow registered a Workspace per
 * exploratory click; `dryRun` reports without touching anything.
 */
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { aheadBehind, currentBranchInfo, hasRemoteBranch, porcelainStatus, unpushedShas, upstreamInfo } from './git.js';
import { archiveWorktree, repoWorktreesRoot, validateManagedWorktree, worktreesRoot } from './worktree.js';

/** Best-effort canonical cwd/nonBlank rows over live sessions, or null when unreadable. */
async function sessionInfo(ctx) {
  const sessions = ctx.get('sessions');
  if (!sessions) return null;
  try {
    const snap =
      (typeof sessions.list === 'function' && await sessions.list()) ||
      (typeof sessions.getSnapshot === 'function' && await sessions.getSnapshot()) ||
      null;
    if (!snap) return null;
    const items = Array.isArray(snap)
      ? snap // Host SessionStore.list(): Session[]
      : Array.isArray(snap.items)
        ? snap.items
        : Array.isArray(snap.ids) && snap.byId
          ? snap.ids.map((id) => snap.byId[id])
          : null;
    if (!items) return null;
    const rows = [];
    for (const summary of items) {
      const cwd = summary?.header?.cwd ?? summary?.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      let canonicalCwd;
      try {
        canonicalCwd = await realpath(cwd);
      } catch {
        return null; // one unknown live-session location disables destructive cleanup
      }
      const blank = typeof summary.blank === 'boolean'
        ? summary.blank
        : typeof summary.seq === 'number'
          ? summary.seq === 0
          : false; // unknown is conservatively in use
      rows.push({ cwd: canonicalCwd, nonBlank: !blank });
    }
    return rows;
  } catch {
    return null;
  }
}

function sessionsWithin(rows, root) {
  if (!rows) return [];
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return rows.filter((row) => row.cwd === root || row.cwd.startsWith(prefix));
}

async function directDirectory(path) {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    return info.isDirectory() && !info.isSymbolicLink() && canonical === path;
  } catch {
    return false;
  }
}

/** Every candidate under the global root, or only one authorized repo hash. */
async function allManagedWorktrees(scopeMainRoot) {
  const groups = [];
  if (scopeMainRoot) {
    groups.push({ root: await repoWorktreesRoot(scopeMainRoot), expectedMainRoot: scopeMainRoot });
  } else {
    const root = worktreesRoot();
    if (!(await directDirectory(root))) return [];
    let hashes;
    try {
      hashes = await readdir(root);
    } catch {
      return [];
    }
    for (const hash of hashes) groups.push({ root: join(root, hash), expectedMainRoot: undefined });
  }

  const out = [];
  for (const group of groups) {
    if (!(await directDirectory(group.root))) continue;
    let entries;
    try {
      entries = await readdir(group.root);
    } catch {
      continue;
    }
    for (const slug of entries) {
      const path = join(group.root, slug);
      const managed = await validateManagedWorktree(path, { expectedMainRoot: group.expectedMainRoot });
      if (managed.ok) out.push({ path: managed.cwd, metadata: managed.metadata, invalidReason: null });
      else out.push({ path, metadata: null, invalidReason: managed.reason });
    }
  }
  return out;
}

/**
 * @param ctx - host plugin context (reads the optional `workspaces` registry
 *   and `sessions` services; both degrade gracefully).
 * @returns {(opts?: {cwd?: string, dryRun?: boolean, allowNoSessionGuard?: boolean}) => Promise<object>}
 */
export function createCleanup(ctx) {
  return async function cleanup(opts = {}) {
    const dryRun = Boolean(opts.dryRun);
    const sessions = await sessionInfo(ctx);
    if (sessions === null && !opts.allowNoSessionGuard) {
      return {
        ok: false,
        error: 'session guard unavailable; re-run with allowNoSessionGuard:true to proceed without it',
      };
    }
    // the host service is named workspaceRegistry (dsh-workspace); the old
    // ctx.get('workspaces') never resolved, so rows survived every sweep
    const registry = ctx.get('workspaceRegistry');
    const managed = await allManagedWorktrees(opts.cwd);
    const report = { ok: true, dryRun, abandoned: Boolean(opts.abandoned), archived: [], skipped: [], workspacesDeleted: [], errors: [] };
    const minAgeMs = typeof opts.minAgeMs === 'number' ? opts.minAgeMs : 30 * 60 * 1000;

    for (const { path, metadata, invalidReason } of managed) {
      if (!metadata) {
        report.errors.push({ path, message: `ownership: ${invalidReason || 'invalid managed worktree'}` });
        continue;
      }
      const skip = (reason) => report.skipped.push({ path, reason });
      const activeSessions = sessionsWithin(sessions, path);
      try {
        if (opts.abandoned) {
          // boot/hourly sweep: only staging leftovers — old enough AND never
          // used (no non-blank session ever pointed at the worktree)
          if (typeof metadata.createdAt !== 'number' || Date.now() - metadata.createdAt < minAgeMs) {
            skip('young');
            continue;
          }
          if (activeSessions.some((session) => session.nonBlank)) {
            skip('session');
            continue;
          }
        }
        const status = await porcelainStatus(path);
        if (!status.ok) throw new Error(`status: ${status.error || 'inspection failed'}`);
        if (status.dirty) {
          skip('dirty');
          continue;
        }
        // The exact recorded commit is the safety boundary. baseRefName is a
        // display/refetch hint and may move, disappear, or be renamed later.
        if (!metadata.baseRef) throw new Error('ahead-behind: recorded base commit unavailable');
        const ahead = await aheadBehind(path, metadata.baseRef);
        if (!ahead.ok) throw new Error(`ahead-behind: ${ahead.error || 'inspection failed'}`);
        if (ahead.ahead > 0) {
          skip('ahead');
          continue;
        }
        const branchNow = (await currentBranchInfo(path)).branch;
        let remoteRef = null;
        if (branchNow && (await hasRemoteBranch(path, branchNow))) remoteRef = `refs/remotes/origin/${branchNow}`;
        else {
          const up = await upstreamInfo(path, branchNow || '');
          remoteRef = up && up.upstreamRef ? up.upstreamRef : null;
        }
        // When no remote ref exists, ahead===0 versus the exact recorded base
        // already proves HEAD carries no task-only commits. Otherwise rev-list
        // must succeed; "unknown" is never treated as an empty set.
        const unpushed = remoteRef ? await unpushedShas(path, remoteRef) : { ok: true, shas: new Set() };
        if (!unpushed.ok) throw new Error(`unpushed: ${unpushed.error || 'inspection failed'}`);
        if (unpushed.shas.size > 0) {
          skip('unpushed');
          continue;
        }
        if (!opts.abandoned && activeSessions.length > 0) {
          skip('session');
          continue;
        }
        if (dryRun) {
          report.archived.push({ path, branch: metadata.branch, dryRun: true });
          continue;
        }
        // Session state can change while the Git inspections above await. Take
        // a fresh snapshot immediately before the destructive archive point.
        const freshSessions = await sessionInfo(ctx);
        if (freshSessions === null && !opts.allowNoSessionGuard) {
          report.errors.push({ path, stage: 'session-guard', message: 'session guard became unavailable before archive' });
          continue;
        }
        const nowActive = sessionsWithin(freshSessions, path);
        if ((!opts.abandoned && nowActive.length > 0)
          || (opts.abandoned && nowActive.some((session) => session.nonBlank))) {
          skip('session');
          continue;
        }
        // Re-run non-force archive guards and let Git's final non-force remove
        // catch files created in the interval after this sweep inspected it.
        const result = await archiveWorktree(path, { force: false });
        if (!result.ok) {
          report.errors.push({ path, stage: result.stage || 'archive', message: result.error || result.message || 'archive failed' });
          continue;
        }
        report.archived.push({ path, branch: metadata.branch });
        if (registry) {
          try {
            // registry contract: list() → entities with .path/.workspaceId;
            // delete(id) takes the id STRING and resolves after the durable
            // registry mutation (idempotent false for unknown ids)
            const hit =
              typeof registry.list === 'function'
                ? registry.list().find((ws) => ws && ws.path === path)
                : null;
            const workspaceId = hit ? (hit.workspaceId ?? hit.id) : undefined;
            if (workspaceId !== undefined && workspaceId !== null) {
              const deleted = await registry.delete(workspaceId);
              if (deleted) report.workspacesDeleted.push(workspaceId);
            }
          } catch (error) {
            report.errors.push({ path, stage: 'workspace-delete', message: String(error?.message ?? error) });
          }
        }
      } catch (error) {
        report.errors.push({ path, stage: 'inspect', message: String(error?.message ?? error) });
      }
    }
    report.ok = report.errors.length === 0;
    return report;
  };
}
