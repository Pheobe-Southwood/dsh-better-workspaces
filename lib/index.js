/**
 * dsh-better-workspaces — host half.
 *
 * Wires the git-state hub to the harness webServer (HTTP + SSE under
 * /better-workspaces/api) and to host activity events so snapshots stay
 * fresh while agents run. Everything degrades gracefully: no webServer →
 * dormant; non-git workspace → {isGit:false}; no gh CLI → forgeAuth flags.
 */
import { createApi } from './api.js';
import { createGitStateHub } from './state.js';

export const name = 'better-workspaces';
export const inject = [];

export function apply(ctx) {
  let broadcast = null;
  const hub = createGitStateHub({
    onChange: (snapshot) => {
      if (broadcast) broadcast(snapshot);
    },
  });

  const webServer = ctx.get('webServer');
  if (webServer) {
    const api = createApi(hub);
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
    ctx.logger?.warn?.('[better-workspaces] webServer service absent — plugin dormant (host-only profiles)');
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
