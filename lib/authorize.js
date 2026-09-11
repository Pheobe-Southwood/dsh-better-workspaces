import { isAbsolute, relative, resolve, sep } from 'node:path';
import { lstat, realpath, stat } from 'node:fs/promises';
import { detectRepo } from './git.js';
import { validateManagedWorktree } from './worktree.js';

function contains(root, target) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function canonicalDirectory(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null;
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

/**
 * Authorize cwd selectors against current durable Workspace roots or one
 * plugin-managed worktree. The caller-provided cwd selects a target; it never
 * proves ownership by itself.
 */
export function createWorkspaceAuthorizer({ workspaceRoots } = {}) {
  const rootsProvider = typeof workspaceRoots === 'function' ? workspaceRoots : () => [];

  async function registeredRoots() {
    let values;
    try {
      values = await rootsProvider();
    } catch {
      return [];
    }
    if (!Array.isArray(values)) return [];
    const roots = [];
    for (const value of values) {
      const path = typeof value === 'string' ? value : value?.path;
      if (typeof path !== 'string' || resolve(path) !== path) continue;
      const canonical = await canonicalDirectory(path);
      // The registry path is the durable anchor. A symlink or a renamed-and-
      // rebound path must not silently retarget that capability.
      let direct = false;
      try {
        direct = canonical === path && !(await lstat(path)).isSymbolicLink();
      } catch {
        direct = false;
      }
      if (direct && !roots.includes(canonical)) roots.push(canonical);
    }
    return roots;
  }

  async function authorize(value) {
    const cwd = await canonicalDirectory(value);
    if (!cwd) return { ok: false, status: 403, error: 'workspace not authorized' };

    const roots = await registeredRoots();
    if (roots.includes(cwd)) {
      const source = await detectRepo(cwd);
      const sourceRoot = source.isGit ? await canonicalDirectory(source.repoRoot) : null;
      const managed = sourceRoot === cwd ? await validateManagedWorktree(cwd) : { ok: false };
      return {
        ok: true,
        cwd,
        root: cwd,
        kind: managed.ok ? 'managed-worktree' : 'workspace',
        gitBoundary: !source.isGit ? 'none' : sourceRoot === cwd ? 'root' : 'nested',
      };
    }

    const allowedMainRoots = [];
    for (const root of roots) {
      const source = await detectRepo(root);
      if (!source.isGit || (await canonicalDirectory(source.repoRoot)) !== root) continue;
      const sourceMain = await canonicalDirectory(source.mainRepoRoot);
      // Only an exact registered main checkout delegates the narrow temporary
      // capability used by its not-yet-registered managed children. A linked
      // Workspace never grants authority over all sibling worktrees.
      if (sourceMain === root && !allowedMainRoots.includes(sourceMain)) allowedMainRoots.push(sourceMain);
    }
    const managed = await validateManagedWorktree(cwd);
    if (managed.ok && allowedMainRoots.includes(managed.mainRepoRoot)) {
      return { ok: true, cwd, root: cwd, kind: 'managed-worktree', gitBoundary: 'root' };
    }

    return { ok: false, status: 403, error: 'workspace not authorized' };
  }

  return { authorize, registeredRoots };
}

export function isWithinRoot(root, target) {
  return contains(resolve(root), resolve(target));
}
