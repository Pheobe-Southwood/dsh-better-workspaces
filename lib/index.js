/**
 * dsh-better-workspaces — host half.
 *
 * Wires the git-state hub to the harness webServer (HTTP + SSE under
 * /better-workspaces/api) and to host activity events so snapshots stay
 * fresh while agents run. `webServer` is declared in `inject`, so the row
 * waits for the service instead of racing cold boot (ADR 0005). Everything
 * else degrades gracefully: non-git workspace → {isGit:false}; no gh CLI →
 * forgeAuth flags.
 */
import { createApi } from './api.js';
import { createAutoNamer } from './autoname.js';
import { createCleanup } from './cleanup.js';
import { readMetadata } from './worktree.js';
import { createGitStateHub } from './state.js';

export const name = 'better-workspaces';
// `webServer` is a hard dependency: without it the plugin has no surface at
// all, and an undeclared read races cold boot — the row used to activate
// before the web app provided the service, take the dormant branch below,
// and never register its routes (ADR 0005). Declaring it makes Cordis wait
// and re-activate the row once the service appears.
export const inject = ['webServer'];

export function apply(ctx) {
  let broadcast = null;
  const hub = createGitStateHub({
    onChange: (snapshot) => {
      if (broadcast) broadcast(snapshot);
    },
  });

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
    // workspace rows whose path is a managed worktree (sidebar icon injector)
    const worktreeWorkspaces = async () => {
      const registry = ctx.get('workspaceRegistry');
      if (!registry || typeof registry.list !== 'function') return [];
      const items = [];
      for (const ws of registry.list()) {
        const path = ws && ws.path;
        if (typeof path !== 'string' || path === '') continue;
        const meta = await readMetadata(path).catch(() => null);
        if (meta) items.push({ workspaceId: ws.workspaceId ?? ws.id, path });
      }
      return items;
    };
    const api = createApi(hub, { cleanup: cleanupFn, worktreeWorkspaces });
    broadcast = api.broadcast;
    ctx.effect(
      () => {
        const unregister = webServer.register(api.route);
        return () => {
          unregister();
          api.dispose();
        };
      },
      'better-workspaces: api routes',
    );
  } else {
    // Unreachable safety net: inject:['webServer'] above keeps the row
    // waiting until the service exists, so apply only runs with it present.
    ctx.logger?.warn?.('[better-workspaces] webServer unexpectedly absent despite inject — plugin dormant');
  }

  // Agent activity → throttled recompute of every active target (5 s floor
  // inside the hub; cheap because snapshots are fingerprint-deduped).
  ctx.on('tools/result', () => hub.refreshActive());
  ctx.on('api-session/status', () => hub.refreshActive());

  ctx.effect(
    () => () => {
      hub.dispose().catch(() => {});
    },
    'better-workspaces: hub',
  );
}
