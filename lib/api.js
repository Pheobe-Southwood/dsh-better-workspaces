/**
 * api.js — same-origin HTTP surface for the client half, mounted on the
 * harness webServer under `/better-workspaces/api`. JSON everywhere plus one
 * SSE stream (`GET /events`) that re-emits hub snapshots on change.
 *
 * Path safety: every `path` parameter is resolved against the request `cwd`
 * and must stay inside it (no absolute paths, no `..` escapes).
 */
import { resolve, sep } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import {
  currentBranchInfo,
  detectRepo,
  hasRemoteBranch,
  listBranches,
  listCommits,
  originUrl,
  resolveDefaultBranch,
  unpushedShas,
  upstreamInfo,
} from './git.js';
import { createWorktree, listManagedWorktrees, mainRepoRootOf, readMetadata, archiveWorktree } from './worktree.js';
import { commitDiff, computeDiff, resolveDiffRefs } from './diff.js';
import { buildActionLadder, executeAction } from './actions.js';

export const API_PREFIX = '/better-workspaces/api';

const TEXT_MAX_BYTES = 1024 * 1024;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const CONTENT_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > TEXT_MAX_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

/** Resolve `rel` inside `cwd`; null on escape attempts. */
function safeResolve(cwd, rel) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const base = resolve(cwd);
  if (rel === undefined || rel === null || rel === '') return base;
  if (typeof rel !== 'string') return null;
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/**
 * Build the webServer route + SSE broadcaster bound to one hub.
 * @returns {{route:object, broadcast:(snapshot:object)=>void, dispose:()=>void}}
 */
export function createApi(hub) {
  const sseClients = new Set();
  const heartbeat = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(':hb\n\n');
      } catch {
        /* dead client; close event cleans up */
      }
    }
  }, 25000);

  const broadcast = (snapshot) => {
    if (sseClients.size === 0) return;
    let data;
    try {
      data = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    } catch {
      return;
    }
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        /* ignore */
      }
    }
  };

  const handler = async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://dsh.local');
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    const sub = url.pathname.slice(API_PREFIX.length) || '/';
    const query = url.params ?? url.searchParams;
    try {
      /* ---------------- discovery ---------------- */
      if (req.method === 'GET' && sub === '/detect') {
        const path = query.get('path');
        if (!path) return sendJson(res, 400, { ok: false, error: 'path required' });
        const detect = await detectRepo(path);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false });
        const [defaultBranch, branchInfo, metadata] = await Promise.all([
          resolveDefaultBranch(detect.repoRoot),
          currentBranchInfo(detect.repoRoot),
          readMetadata(path).catch(() => null),
        ]);
        return sendJson(res, 200, {
          ok: true,
          isGit: true,
          repoRoot: detect.repoRoot,
          mainRepoRoot: detect.mainRepoRoot,
          isLinkedWorktree: detect.isLinkedWorktree,
          managed: Boolean(metadata),
          defaultBranch,
          branch: branchInfo.branch,
        });
      }

      if (req.method === 'GET' && sub === '/branches') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const detect = await detectRepo(cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false, branches: [] });
        const [branches, defaultBranch, branchInfo] = await Promise.all([
          listBranches(detect.repoRoot),
          resolveDefaultBranch(detect.repoRoot),
          currentBranchInfo(cwd),
        ]);
        return sendJson(res, 200, {
          ok: true,
          isGit: true,
          defaultBranch,
          current: branchInfo.branch,
          branches: branches.map((b) => ({ ...b, current: b.name === branchInfo.branch })),
        });
      }

      if (req.method === 'GET' && sub === '/worktrees') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const detect = await detectRepo(cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false, items: [] });
        const result = await listManagedWorktrees(detect.repoRoot, cwd);
        return sendJson(res, 200, { ok: true, ...result });
      }

      /* ---------------- worktree lifecycle ---------------- */
      if (req.method === 'POST' && sub === '/worktrees') {
        const body = await readBody(req);
        if (!body.cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const mainRoot = await mainRepoRootOf(body.cwd);
        try {
          const created = await createWorktree({
            repoRoot: mainRoot,
            base: body.base || undefined,
            intent: body.intent === 'branch-off' ? 'branch-off' : 'checkout',
            branchName: body.branchName || undefined,
            slug: body.slug || undefined,
          });
          return sendJson(res, 200, { ok: true, ...created });
        } catch (error) {
          return sendJson(res, 200, { ok: false, message: String(error?.message ?? error).slice(0, 600) });
        }
      }

      if (req.method === 'POST' && sub === '/worktrees/archive') {
        const body = await readBody(req);
        if (!body.path) return sendJson(res, 400, { ok: false, error: 'path required' });
        const result = await archiveWorktree(body.path, { force: Boolean(body.force) });
        return sendJson(res, 200, result);
      }

      /* ---------------- snapshots + SSE ---------------- */
      if (req.method === 'POST' && sub === '/snapshots') {
        const body = await readBody(req);
        const byCwd = await hub.snapshots(Array.isArray(body.cwds) ? body.cwds : []);
        return sendJson(res, 200, { ok: true, byCwd });
      }

      if (req.method === 'GET' && sub === '/snapshot') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        // explicit single-target request: always fresh (batch /snapshots keeps the 3 s cache)
        const snapshot = await hub.snapshotFor(cwd, { fresh: true });
        return sendJson(res, 200, { ok: true, snapshot });
      }

      if (req.method === 'GET' && sub === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write('retry: 5000\n:connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        req.on('error', () => sseClients.delete(res));
        return; // keep the response open
      }

      /* ---------------- diffs & commits ---------------- */
      if (req.method === 'GET' && sub === '/diff') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const mode = query.get('mode') === 'base' ? 'base' : 'uncommitted';
        const commit = query.get('commit');
        const path = query.get('path') || undefined;
        const ignoreWhitespace = query.get('w') === '1';
        const result = commit
          ? await commitDiff(cwd, commit, { ignoreWhitespace, path })
          : await computeDiff(cwd, { mode, baseRef: query.get('base') || undefined, ignoreWhitespace, path });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'GET' && sub === '/commits') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const refs = await resolveDiffRefs(cwd, { mode: 'base', baseRef: query.get('base') || undefined });
        const commits = await listCommits(cwd, `${refs.baseRef}..HEAD`, 200);
        const branchInfo = await currentBranchInfo(cwd);
        let remoteRef = null;
        if (branchInfo.branch) {
          const up = await upstreamInfo(cwd, branchInfo.branch);
          if (up.upstreamRef) remoteRef = up.upstreamRef;
          else if (await hasRemoteBranch(cwd, branchInfo.branch)) remoteRef = `refs/remotes/origin/${branchInfo.branch}`;
        }
        const unpushed = remoteRef ? await unpushedShas(cwd, remoteRef) : null;
        return sendJson(res, 200, {
          ok: true,
          base: refs.label,
          baseRef: refs.baseRef,
          remoteRef,
          commits: commits.map((c) => ({ ...c, unpushed: unpushed ? unpushed.has(c.sha) : true })),
        });
      }

      /* ---------------- actions ---------------- */
      if (req.method === 'GET' && sub === '/actions') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        // the ladder drives destructive buttons — always compute fresh
        const snapshot = await hub.snapshotFor(cwd, { fresh: true });
        const ladder = buildActionLadder(snapshot, { agentRunning: query.get('running') === '1' });
        return sendJson(res, 200, { ok: true, ladder, snapshot });
      }

      if (req.method === 'POST' && sub === '/action') {
        const body = await readBody(req);
        if (!body.cwd || !body.name) return sendJson(res, 400, { ok: false, error: 'cwd and name required' });
        const result = await executeAction(hub, body.cwd, body.name, body.params ?? {});
        return sendJson(res, 200, result ?? { ok: false });
      }

      /* ---------------- files view ---------------- */
      if (req.method === 'GET' && sub === '/tree') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const dir = safeResolve(cwd, rel);
        if (!dir) return sendJson(res, 403, { ok: false, error: 'path escapes workspace' });
        let dirents;
        try {
          dirents = await readdir(dir, { withFileTypes: true });
        } catch {
          return sendJson(res, 200, { ok: true, entries: [], missing: true });
        }
        const entries = [];
        for (const dirent of dirents) {
          if (dirent.name === '.git') continue;
          const isDir = dirent.isDirectory();
          let size = null;
          if (!isDir) {
            try {
              size = (await stat(resolve(dir, dirent.name))).size;
            } catch {
              size = null;
            }
          }
          entries.push({
            name: dirent.name,
            path: rel === '' ? dirent.name : `${rel.replace(/\/+$/, '')}/${dirent.name}`,
            type: isDir ? 'dir' : 'file',
            size,
          });
          if (entries.length >= 3000) break;
        }
        entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        return sendJson(res, 200, { ok: true, path: rel, entries });
      }

      if (req.method === 'GET' && sub === '/file') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') return sendJson(res, 400, { ok: false, error: 'cwd and path required' });
        const file = safeResolve(cwd, rel);
        if (!file) return sendJson(res, 403, { ok: false, error: 'path escapes workspace' });
        let s;
        try {
          s = await stat(file);
        } catch {
          return sendJson(res, 200, { ok: true, kind: 'missing' });
        }
        if (!s.isFile()) return sendJson(res, 200, { ok: true, kind: 'not-file' });
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        if (IMAGE_EXT.has(ext)) {
          const encoded = rel.split('/').map(encodeURIComponent).join('/');
          return sendJson(res, 200, {
            ok: true,
            kind: 'image',
            size: s.size,
            url: `${API_PREFIX}/raw?cwd=${encodeURIComponent(cwd)}&path=${encoded}`,
          });
        }
        if (s.size > TEXT_MAX_BYTES) return sendJson(res, 200, { ok: true, kind: 'too_large', size: s.size });
        const buffer = await readFile(file);
        const head = buffer.subarray(0, 8000);
        if (head.includes(0)) return sendJson(res, 200, { ok: true, kind: 'binary', size: s.size });
        return sendJson(res, 200, { ok: true, kind: 'text', size: s.size, content: buffer.toString('utf8') });
      }

      if (req.method === 'GET' && sub === '/raw') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') {
          res.writeHead(400).end();
          return;
        }
        const file = safeResolve(cwd, rel);
        if (!file) {
          res.writeHead(403).end();
          return;
        }
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        if (!IMAGE_EXT.has(ext)) {
          res.writeHead(415).end();
          return;
        }
        try {
          const s = await stat(file);
          res.writeHead(200, {
            'Content-Type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
            'Content-Length': s.size,
            'Cache-Control': 'no-store',
          });
          const stream = createReadStream(file);
          stream.on('error', () => res.end());
          stream.pipe(res);
        } catch {
          res.writeHead(404).end();
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown route ${sub}` });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error).slice(0, 400) });
      else res.end();
    }
  };

  const route = { kind: 'prefix', path: API_PREFIX, handler };
  const dispose = () => {
    clearInterval(heartbeat);
    for (const res of sseClients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  };
  return { route, broadcast, dispose };
}
