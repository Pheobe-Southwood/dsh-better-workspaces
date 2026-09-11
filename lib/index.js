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

export const name = 'better-workspaces';
// `webServer` and `workspaceRegistry` are hard dependencies: without the
// first there is no surface; without the second cwd would have no authority
// source. Cordis waits and re-activates after both appear (ADR 0005/0010).
export const inject = ['webServer', 'workspaceRegistry'];

export function apply(ctx) {
  let broadcast = null;
  const hub = createGitStateHub({
    onChange: (snapshot) => {
      if (broadcast) broadcast(snapshot);
    },
  });
  // Register ownership immediately so any later apply failure rolls timers and
  // watchers back with the Cordis fiber.
  ctx.effect(
    () => () => {
      hub.dispose().catch(() => {});
    },
    'better-workspaces: hub',
  );

  // first-message LLM rename of auto-placeholder worktree branches (ADR 0004);
  // degrades to keeping placeholders when llm/agentDefaultModel are absent
  const namer = createAutoNamer(ctx, hub);
  ctx.effect(
    () => () => {
      namer.dispose();
    },
    'better-workspaces: autoname',
  );

  // abandoned staging leftovers (blank-only sessions, clean, old enough) are
  // swept once shortly after boot and hourly thereafter
  const cleanupFn = createCleanup(ctx);
  ctx.effect(
    () => {
      let stopped = false;
      const sweep = () => {
        if (stopped) return;
        cleanupFn({ abandoned: true }).catch(() => {});
      };
      const boot = setTimeout(sweep, 5000);
      const hourly = setInterval(sweep, 60 * 60 * 1000);
      return () => {
        stopped = true;
        clearTimeout(boot);
        clearInterval(hourly);
      };
    },
    'better-workspaces: abandoned sweep',
  );

  const webServer = ctx.get('webServer');
  if (webServer) {
    const registry = ctx.get('workspaceRegistry');
    const workspaceRoots = () => registry.list().map((workspace) => workspace.path);
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
    const api = createApi(hub, { cleanup: cleanupFn, workspaceRoots, worktreeWorkspaces });
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
        return () => {
          unregister();
          api.dispose();
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
