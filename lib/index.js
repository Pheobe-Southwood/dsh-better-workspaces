/**
 * dsh-better-workspaces — host half.
 *
 * Wires the git-state hub to the harness webServer (HTTP + SSE under
 * /better-workspaces/api) and to host activity events so snapshots stay
 * fresh while agents run. `webServer` and the Workspace registry are hard
 * dependencies, so routes cannot race cold boot or mount without their
 * authorization source (ADR 0005, ADR 0010). Optional integrations still
 * degrade gracefully: non-git Workspace → {isGit:false}; no gh CLI → flags.
 */
import { createApi } from './api.js';
import { createAutoNamer } from './autoname.js';
import { createCleanup } from './cleanup.js';
import { validateManagedWorktree } from './worktree.js';
import { createGitStateHub } from './state.js';
import { createWorkspaceAuthorizer } from './authorize.js';
import { hostMutationCoordinator } from './mutation.js';

export const name = 'better-workspaces';

export function createCleanupScheduler(cleanupFn, options = {}) {
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  let stopped = false;
  let sweeping = null;
  const sweep = () => {
    if (stopped || sweeping) return sweeping;
    sweeping = Promise.resolve(cleanupFn({ abandoned: true, automatic: true, signal: options.signal }))
      .catch(() => {})
      .finally(() => { sweeping = null; });
    return sweeping;
  };
  const boot = options.start === false ? null : setTimeoutFn(sweep, options.bootDelayMs ?? 5000);
  const hourly = options.start === false ? null : setIntervalFn(sweep, options.intervalMs ?? 60 * 60 * 1000);
  return {
    sweep,
    async dispose() {
      if (!stopped) {
        stopped = true;
        options.onStop?.();
        if (boot !== null) clearTimeoutFn(boot);
        if (hourly !== null) clearIntervalFn(hourly);
      }
      await sweeping;
    },
  };
}

// `webServer` and `workspaceRegistry` are hard dependencies: without the
// first there is no surface; without the second cwd would have no authority
// source. Cordis waits and re-activates after both appear (ADR 0005/0010).
export const inject = ['webServer', 'workspaceRegistry'];

export function apply(ctx) {
  let broadcast = null;
  const lifecycle = new AbortController();
  const mutations = hostMutationCoordinator;
  const registry = ctx.get('workspaceRegistry');
  const workspaceRows = () => registry.list();
  const workspaceRoots = () => workspaceRows().map((workspace) => workspace.path);
  const authorizer = createWorkspaceAuthorizer({ workspaceRoots });
  const hub = createGitStateHub({
    mutations,
    authorizeTarget: (cwd) => authorizer.authorize(cwd),
    onChange: (snapshot) => {
      if (broadcast) broadcast(snapshot);
    },
  });
  // Register ownership immediately so any later apply failure rolls timers and
  // watchers back with the Cordis fiber.
  ctx.effect(
    () => () => hub.dispose(),
    'better-workspaces: hub',
  );
  ctx.effect(
    () => () => lifecycle.abort(),
    'better-workspaces: lifecycle abort',
  );

  // first-message LLM rename of auto-placeholder worktree branches (ADR 0004);
  // degrades to keeping placeholders when llm/agentDefaultModel are absent
  const namer = createAutoNamer(ctx, hub, {
    mutations,
    authorizeTarget: (cwd) => authorizer.authorize(cwd),
  });
  ctx.effect(
    () => () => namer.dispose(),
    'better-workspaces: autoname',
  );

  // Boot/hourly jobs replay durable recovery records only. Destructive
  // abandoned cleanup stays explicit until Session exposes an atomic lease.
  const cleanupFn = createCleanup(ctx, { mutations, signal: lifecycle.signal });
  ctx.effect(
    () => {
      const scheduler = createCleanupScheduler(cleanupFn, {
        signal: lifecycle.signal,
        onStop: () => lifecycle.abort(),
      });
      return () => scheduler.dispose();
    },
    'better-workspaces: abandoned sweep',
  );

  const webServer = ctx.get('webServer');
  if (webServer) {
    // workspace rows whose path is a managed worktree (sidebar icon injector)
    const worktreeWorkspaces = async () => {
      if (!registry || typeof registry.list !== 'function') return [];
      const items = [];
      for (const ws of registry.list()) {
        const path = ws && ws.path;
        if (typeof path !== 'string' || path === '') continue;
        const managed = await validateManagedWorktree(path);
        if (managed.ok) items.push({ workspaceId: ws.workspaceId ?? ws.id, path: managed.cwd });
      }
      return items;
    };
    const api = createApi(hub, {
      cleanup: cleanupFn,
      workspaceRoots,
      worktreeWorkspaces,
      workspaceRows,
      deleteWorkspace: (workspaceId) => registry.delete(workspaceId),
      mutations,
    });
    broadcast = api.broadcast;
    ctx.effect(
      () => {
        let unregister;
        try {
          unregister = webServer.register(api.route);
        } catch (error) {
          api.dispose();
          throw error;
        }
        return async () => {
          unregister();
          await api.dispose();
        };
      },
      'better-workspaces: api routes',
    );
  } else {
    // Unreachable safety net: inject above keeps the row waiting until the
    // route and authorization services exist.
    ctx.logger?.warn?.('[better-workspaces] webServer unexpectedly absent despite inject — plugin dormant');
  }

  // Agent activity → throttled recompute of every active target (5 s floor
  // inside the hub; cheap because snapshots are fingerprint-deduped).
  ctx.on('tools/result', () => hub.refreshActive());
  ctx.on('api-session/status', () => hub.refreshActive());

}
