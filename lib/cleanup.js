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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { aheadBehind, currentBranchInfo, hasRemoteBranch, porcelainStatus, unpushedShas, upstreamInfo } from './git.js';
import { archiveWorktree, readMetadata, worktreesRoot } from './worktree.js';

/** Best-effort map cwd → {nonBlank} over live sessions, or null when unreadable. */
function sessionInfo(ctx) {
  const sessions = ctx.get('sessions');
  if (!sessions) return null;
  try {
    const snap =
      (typeof sessions.list === 'function' && sessions.list()) ||
      (typeof sessions.getSnapshot === 'function' && sessions.getSnapshot()) ||
      null;
    if (!snap) return null;
    const items = Array.isArray(snap.items)
      ? snap.items
      : Array.isArray(snap.ids) && snap.byId
        ? snap.ids.map((id) => snap.byId[id])
        : null;
    if (!items) return null;
    const map = new Map();
    for (const summary of items) {
      const cwd = summary?.header?.cwd ?? summary?.cwd;
      if (typeof cwd !== 'string' || cwd === '') continue;
      // unknown blank flag ⇒ treat as in use (safe direction)
      const nonBlank = summary.blank !== true;
      const prev = map.get(cwd);
      map.set(cwd, prev ? { nonBlank: prev.nonBlank || nonBlank } : { nonBlank });
    }
    return map;
  } catch {
    return null;
  }
}

/** Every managed worktree directory under the worktrees root. */
async function allManagedWorktrees() {
  const root = worktreesRoot();
  let hashes;
  try {
    hashes = await readdir(root);
  } catch {
    return [];
  }
  const out = [];
  for (const hash of hashes) {
    let entries;
    try {
      entries = await readdir(join(root, hash));
    } catch {
      continue;
    }
    for (const slug of entries) {
      const path = join(root, hash, slug);
      const metadata = await readMetadata(path).catch(() => null);
      if (metadata) out.push({ path, metadata });
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
    const sessions = sessionInfo(ctx);
    if (sessions === null && !opts.allowNoSessionGuard) {
      return {
        ok: false,
        error: 'session guard unavailable; re-run with allowNoSessionGuard:true to proceed without it',
      };
    }
    // the host service is named workspaceRegistry (dsh-workspace); the old
    // ctx.get('workspaces') never resolved, so rows survived every sweep
    const registry = ctx.get('workspaceRegistry');
    const managed = await allManagedWorktrees();
    const report = { ok: true, dryRun, abandoned: Boolean(opts.abandoned), archived: [], skipped: [], workspacesDeleted: [], errors: [] };
    const minAgeMs = typeof opts.minAgeMs === 'number' ? opts.minAgeMs : 30 * 60 * 1000;

    for (const { path, metadata } of managed) {
      if (opts.cwd && metadata.mainRepoRoot !== opts.cwd) continue;
      const skip = (reason) => report.skipped.push({ path, reason });
      const info = sessions ? sessions.get(path) : undefined;
      try {
        if (opts.abandoned) {
          // boot/hourly sweep: only staging leftovers — old enough AND never
          // used (no non-blank session ever pointed at the worktree)
          if (typeof metadata.createdAt !== 'number' || Date.now() - metadata.createdAt < minAgeMs) {
            skip('young');
            continue;
          }
          if (info && info.nonBlank) {
            skip('session');
            continue;
          }
        }
        const status = await porcelainStatus(path);
        if (status.dirty) {
          skip('dirty');
          continue;
        }
        const ahead = await aheadBehind(path, metadata.baseRefName || metadata.baseRef || 'HEAD');
        if (ahead && ahead.ahead > 0) {
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
        const unpushed = await unpushedShas(path, remoteRef || undefined);
        if (unpushed.size > 0) {
          skip('unpushed');
          continue;
        }
        if (!opts.abandoned && info) {
          skip('session');
          continue;
        }
        if (dryRun) {
          report.archived.push({ path, branch: metadata.branch, dryRun: true });
          continue;
        }
        // own guards above are strictly stronger than archiveWorktree's
        // (dirty + ahead-of-base + unpushed-vs-remote + session), so force is
        // safe here and sidesteps the archive guard's conservative counting
        const result = await archiveWorktree(path, { force: true });
        if (!result.ok) {
          skip(result.error || result.message || 'archive failed');
          continue;
        }
        report.archived.push({ path, branch: metadata.branch });
        if (registry) {
          try {
            // registry contract: list() → entities with .path/.workspaceId;
            // delete(id) takes the id STRING (synchronous, idempotent no-op
            // for unknown ids)
            const hit =
              typeof registry.list === 'function'
                ? registry.list().find((ws) => ws && ws.path === path)
                : null;
            const workspaceId = hit ? (hit.workspaceId ?? hit.id) : undefined;
            if (workspaceId !== undefined && workspaceId !== null) {
              registry.delete(workspaceId);
              report.workspacesDeleted.push(workspaceId);
            }
          } catch (error) {
            report.errors.push({ path, stage: 'workspace-delete', message: String(error?.message ?? error) });
          }
        }
      } catch (error) {
        report.errors.push({ path, stage: 'inspect', message: String(error?.message ?? error) });
      }
    }
    return report;
  };
}
