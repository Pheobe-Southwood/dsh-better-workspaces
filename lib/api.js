/**
 * api.js — same-origin HTTP surface for the client half, mounted on the
 * harness webServer under `/better-workspaces/api`. JSON everywhere plus one
 * SSE stream (`GET /events`) that re-emits hub snapshots on change.
 *
 * Boundary safety: cwd/path values only select a registry-backed Workspace or
 * verified managed worktree. File paths must remain inside it both lexically
 * and after realpath resolution; Git revisions are typed before execution.
 */
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { lstat, open, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  currentBranchInfo,
  detectRepo,
  hasRemoteBranch,
  listBranches,
  listCommits,
  originUrl,
  resolveDefaultBranch,
  runGit,
  unpushedShas,
  upstreamInfo,
} from './git.js';
import {
  archiveWorktree,
  createWorktree,
  listManagedWorktrees,
  mainRepoRootOf,
  readMetadata,
  validateWorktreeSelectors,
} from './worktree.js';
import { listForgeItems, pullRequestDetail } from './forge.js';
import { commitDiff, computeDiff, resolveDiffRefs } from './diff.js';
import { buildActionLadder, executeAction } from './actions.js';
import { createWorkspaceAuthorizer, isWithinRoot } from './authorize.js';

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

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function actionFailureStatus(actionName, result) {
  if (Number.isInteger(result?.status) && result.status >= 400 && result.status <= 599) return result.status;
  if (result?.reason === 'inspect-failed') return 500;
  if (['target-unauthorized', 'not-managed'].includes(result?.reason)) return 403;
  if (result?.reasonKey === 'actions.commit.noMessage') return 422;
  const conflict = result?.reasonKey || ['merge-in-progress', 'conflict', 'dirty', 'ahead', 'unpushed', 'unsafe'].includes(result?.reason);
  if (conflict) return 409;
  if (['pull', 'push', 'fetch', 'createPr', 'mergePr', 'enableAutoMerge', 'disableAutoMerge'].includes(actionName)) return 502;
  return 500;
}

function worktreeFailureStatus(result) {
  if (Number.isInteger(result?.status)) return result.status;
  const reason = result?.error || result?.reason;
  if (['dirty', 'ahead', 'unpushed', 'active-session', 'unsafe'].includes(reason)) return 409;
  if (reason === 'not-managed') return 403;
  return 500;
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > TEXT_MAX_BYTES) {
      req.resume();
      reject(new ApiError(413, 'body too large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > TEXT_MAX_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new ApiError(413, 'body too large'));
      if (chunks.length === 0) return resolvePromise({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ApiError(400, 'JSON object required');
        }
        resolvePromise(parsed);
      } catch (error) {
        reject(error instanceof ApiError ? error : new ApiError(400, 'malformed JSON'));
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
  if (!isWithinRoot(base, target)) return null;
  return target;
}

function sameOrigin(req) {
  const rawOrigin = req.headers.origin;
  const host = req.headers.host;
  if (typeof rawOrigin !== 'string' || typeof host !== 'string') return false;
  try {
    const origin = new URL(rawOrigin);
    const protocol = req.socket?.encrypted ? 'https' : 'http';
    return origin.host.toLowerCase() === host.toLowerCase() && origin.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

async function existingPathWithin(auth, rel) {
  const lexical = safeResolve(auth.cwd, rel);
  if (!lexical) return { ok: false, status: 403, error: 'path escapes workspace' };
  const relFromRoot = relative(auth.root, lexical);
  if (relFromRoot.split(sep).includes('.git')) {
    return { ok: false, status: 403, error: 'git administrative paths are not editable' };
  }
  try {
    const file = await realpath(lexical);
    if (!isWithinRoot(auth.root, file)) return { ok: false, status: 403, error: 'path escapes workspace' };
    return { ok: true, file, lexical };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, status: 404, error: 'missing' };
    return { ok: false, status: 403, error: 'path unavailable' };
  }
}

async function verifyOpenIdentity(handle, auth, lexical) {
  try {
    const rebound = await realpath(lexical);
    if (!isWithinRoot(auth.root, rebound)) return false;
    const [openedStat, reboundStat] = await Promise.all([handle.stat(), stat(rebound)]);
    return openedStat.dev === reboundStat.dev && openedStat.ino === reboundStat.ino;
  } catch {
    return false;
  }
}

async function readCapped(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return null;
}

async function openRegularFile(auth, located) {
  const handle = await open(located.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || !(await verifyOpenIdentity(handle, auth, located.lexical))) {
      await handle.close();
      return null;
    }
    return { handle, stat: fileStat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function openAnchoredParent(auth, located) {
  if (process.platform !== 'linux') throw new ApiError(503, 'atomic workspace save requires Linux dirfd support');
  // Writes use /proc/self/fd as Node's dirfd-relative bridge: every temp/open/
  // rename remains attached to this verified directory inode if a pathname is
  // concurrently rebound.
  if (located.file !== located.lexical) throw new ApiError(403, 'saving through symlinks is not allowed');
  const canonicalParent = dirname(located.file);
  const lexicalParent = dirname(located.lexical);
  const handle = await open(canonicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await verifyOpenIdentity(handle, auth, lexicalParent))) throw new ApiError(409, 'file path changed during save');
    const anchor = `/proc/self/fd/${handle.fd}`;
    if ((await realpath(anchor)) !== canonicalParent) throw new ApiError(409, 'file path changed during save');
    return { handle, anchor, lexicalParent };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readAnchoredRegular(anchor, name) {
  const handle = await open(`${anchor}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return null;
    return { buffer: fileStat.size <= TEXT_MAX_BYTES ? await readCapped(handle, TEXT_MAX_BYTES) : null, stat: fileStat };
  } finally {
    await handle.close().catch(() => {});
  }
}

function createKeyedMutex() {
  const tails = new Map();
  return async (key) => {
    const previous = tails.get(key) || Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (tails.get(key) === tail) tails.delete(key);
    };
  };
}

async function removeMatchingIdentity(path, identity) {
  if (!path || !identity) return false;
  try {
    const current = await lstat(path);
    if (current.dev !== identity.dev || current.ino !== identity.ino) return false;
    await rm(path, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function exchangeAnchored(parentHandle, sourceName, targetName) {
  return new Promise((resolveExchange, rejectExchange) => {
    // GNU mv --exchange maps to renameat2(RENAME_EXCHANGE); --no-copy makes a
    // missing kernel primitive fail closed. Child fd 3 inherits the verified
    // parent directory, so neither operand is reopened through an ambient path.
    const child = spawn(
      '/usr/bin/mv',
      [
        '--exchange',
        '--no-copy',
        '-T',
        '--',
        `/proc/self/fd/3/${sourceName}`,
        `/proc/self/fd/3/${targetName}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', parentHandle.fd], windowsHide: true },
    );
    const chunks = [];
    let size = 0;
    child.stderr.on('data', (chunk) => {
      if (size >= 64 * 1024) return;
      const kept = chunk.subarray(0, 64 * 1024 - size);
      chunks.push(kept);
      size += kept.length;
    });
    child.once('error', (error) => rejectExchange(new ApiError(503, `atomic file exchange unavailable: ${error.message}`)));
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) resolveExchange();
      else {
        const stderr = Buffer.concat(chunks).toString('utf8').trim();
        rejectExchange(new ApiError(503, `atomic file exchange unavailable: ${stderr || signal || `exit ${code}`}`.slice(0, 300)));
      }
    });
  });
}

/**
 * Build the webServer route + SSE broadcaster bound to one hub.
 * @returns {{route:object, broadcast:(snapshot:object)=>void, dispose:()=>void}}
 */
export function createApi(hub, options = {}) {
  const cleanup = typeof options.cleanup === 'function' ? options.cleanup : null;
  const resolvePull = typeof options.resolvePull === 'function' ? options.resolvePull : pullRequestDetail;
  const worktreeWorkspaces =
    typeof options.worktreeWorkspaces === 'function' ? options.worktreeWorkspaces : null;
  const authorizer = createWorkspaceAuthorizer({ workspaceRoots: options.workspaceRoots });
  const lockFileMutation = createKeyedMutex();
  const authorize = async (res, selector) => {
    const result = await authorizer.authorize(selector);
    if (!result.ok) sendJson(res, result.status || 403, { ok: false, error: result.error });
    return result.ok ? result : null;
  };
  const authorizeGit = async (res, selector, { allowNonGit = false } = {}) => {
    const result = await authorize(res, selector);
    if (!result) return null;
    if (result.gitBoundary === 'nested') {
      sendJson(res, 403, { ok: false, error: 'git repository root not authorized' });
      return null;
    }
    if (result.gitBoundary === 'none' && !allowNonGit) {
      sendJson(res, 422, { ok: false, error: 'git repository required' });
      return null;
    }
    return result;
  };
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
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (contentType.split(';', 1)[0].trim() !== 'application/json') {
        return sendJson(res, 415, { ok: false, error: 'application/json required' });
      }
      if (!sameOrigin(req) || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')) {
        return sendJson(res, 403, { ok: false, error: 'same-origin request required' });
      }
    }
    try {
      /* ---------------- discovery ---------------- */
      if (req.method === 'GET' && sub === '/detect') {
        const path = query.get('path');
        if (!path) return sendJson(res, 400, { ok: false, error: 'path required' });
        const auth = await authorizeGit(res, path, { allowNonGit: true });
        if (!auth) return;
        const detect = await detectRepo(auth.cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false });
        const [defaultBranch, branchInfo, metadata] = await Promise.all([
          resolveDefaultBranch(detect.repoRoot),
          currentBranchInfo(detect.repoRoot),
          readMetadata(auth.cwd).catch(() => null),
        ]);
        return sendJson(res, 200, {
          ok: true,
          isGit: true,
          repoRoot: detect.repoRoot,
          mainRepoRoot: detect.mainRepoRoot,
          isLinkedWorktree: detect.isLinkedWorktree,
          managed: auth.kind === 'managed-worktree',
          defaultBranch,
          branch: branchInfo.branch,
          ...(metadata && metadata.sourceWorkspaceTitle
            ? { sourceWorkspaceTitle: metadata.sourceWorkspaceTitle }
            : {}),
        });
      }

      if (req.method === 'GET' && sub === '/branches') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const detect = await detectRepo(auth.cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false, branches: [] });
        const [branches, defaultBranch, branchInfo] = await Promise.all([
          listBranches(detect.repoRoot),
          resolveDefaultBranch(detect.repoRoot),
          currentBranchInfo(auth.cwd),
        ]);
        return sendJson(res, 200, {
          ok: true,
          isGit: true,
          defaultBranch,
          current: branchInfo.branch,
          branches: branches.map((b) => ({ ...b, current: b.name === branchInfo.branch })),
        });
      }

      /* ---------------- forge (issue / pull request picker) ---------------- */
      if (req.method === 'GET' && sub === '/pulls') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const detect = await detectRepo(auth.cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false, items: [], authState: 'no_remote' });
        const limit = Math.min(Math.max(Number(query.get('limit')) || 20, 1), 50);
        // `gh` resolves the repository from its own cwd, so the main checkout
        // and every linked worktree list the same repository; there is no
        // owner/repo in the contract.
        const result = await listForgeItems({ cwd: detect.repoRoot, query: '', limit });
        return sendJson(res, 200, { ok: true, isGit: true, ...result });
      }

      if (req.method === 'GET' && sub === '/pull') {
        const cwd = query.get('cwd');
        const number = Number(query.get('number'));
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        if (!Number.isInteger(number) || number <= 0) {
          return sendJson(res, 400, { ok: false, error: 'number required' });
        }
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const detect = await detectRepo(auth.cwd);
        if (!detect.isGit) return sendJson(res, 422, { ok: false, authState: 'no_remote', message: 'not a git repository' });
        const kind = query.get('kind') === 'issue' ? 'issue' : query.get('kind') === 'change_request' ? 'change_request' : undefined;
        const result = await pullRequestDetail({ cwd: detect.repoRoot, number, kind });
        if (!result.ok) {
          const status = result.reason === 'not_found'
            ? 404
            : ['cli_missing', 'unauthenticated'].includes(result.authState)
              ? 503
              : 502;
          return sendJson(res, status, { ok: false, authState: result.authState, reason: result.reason, message: result.message });
        }
        return sendJson(res, 200, { ok: true, item: result.item });
      }

      if (req.method === 'GET' && sub === '/worktrees') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        const detect = await detectRepo(auth.cwd);
        if (!detect.isGit) return sendJson(res, 200, { ok: true, isGit: false, items: [] });
        const result = await listManagedWorktrees(detect.repoRoot, auth.cwd);
        const items = [];
        for (const item of result.items) {
          const itemAuth = await authorizer.authorize(item.path);
          if (itemAuth.ok && itemAuth.gitBoundary === 'root') items.push({ ...item, path: itemAuth.cwd });
        }
        const mainAuth = await authorizer.authorize(result.mainRepoRoot);
        return sendJson(res, 200, {
          ok: true,
          mainRepoRoot: mainAuth.ok && mainAuth.gitBoundary === 'root' ? mainAuth.cwd : null,
          root: mainAuth.ok && mainAuth.gitBoundary === 'root' ? result.root : null,
          items,
        });
      }

      /* ---------------- worktree lifecycle ---------------- */
      if (req.method === 'POST' && sub === '/worktrees') {
        const body = await readBody(req);
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd required', message: 'cwd required' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        if ((body.base !== undefined && typeof body.base !== 'string')
          || (body.branchName !== undefined && typeof body.branchName !== 'string')
          || (body.slug !== undefined && typeof body.slug !== 'string')
          || (body.sourceTitle !== undefined && typeof body.sourceTitle !== 'string')
          || (body.intent !== undefined && !['checkout', 'branch-off'].includes(body.intent))) {
          return sendJson(res, 400, { ok: false, error: 'invalid worktree request' });
        }
        if (body.pull !== undefined && (!body.pull || !Number.isSafeInteger(body.pull.number)
          || body.pull.number <= 0 || typeof body.pull.headRef !== 'string' || body.pull.headRef === ''
          || (body.pull.baseRef !== undefined && body.pull.baseRef !== null && typeof body.pull.baseRef !== 'string')
          || (body.pull.forkOwner !== undefined && body.pull.forkOwner !== null && typeof body.pull.forkOwner !== 'string'))) {
          return sendJson(res, 400, { ok: false, error: 'invalid pull request selector' });
        }
        let pull = body.pull
          ? {
              number: body.pull.number,
              headRef: body.pull.headRef,
              baseRef: typeof body.pull.baseRef === 'string' && body.pull.baseRef !== '' ? body.pull.baseRef : null,
              forkOwner: typeof body.pull.forkOwner === 'string' && body.pull.forkOwner !== '' ? body.pull.forkOwner : null,
            }
          : null;
        const intent = pull ? 'pr-checkout' : body.intent === 'branch-off' ? 'branch-off' : 'checkout';
        try {
          validateWorktreeSelectors({ base: body.base, branchName: body.branchName, intent, pull });
        } catch (error) {
          return sendJson(res, 422, { ok: false, error: error.message });
        }
        if (pull) {
          const detail = await resolvePull({ cwd: auth.cwd, number: pull.number, kind: 'change_request' });
          if (!detail?.ok) {
            const status = detail?.reason === 'not_found'
              ? 404
              : ['cli_missing', 'unauthenticated'].includes(detail?.authState)
                ? 503
                : 502;
            return sendJson(res, status, { ok: false, error: 'pull request verification failed', message: detail?.message });
          }
          const item = detail.item;
          if (item?.kind !== 'change_request' || item.number !== pull.number
            || typeof item.headRefName !== 'string' || item.headRefName === ''
            || (item.fork && (typeof item.headOwnerLogin !== 'string' || item.headOwnerLogin === ''))) {
            return sendJson(res, 502, { ok: false, error: 'forge returned invalid pull request identity' });
          }
          pull = {
            number: item.number,
            headRef: item.headRefName,
            baseRef: typeof item.baseRefName === 'string' && item.baseRefName !== '' ? item.baseRefName : null,
            forkOwner: item.fork ? item.headOwnerLogin : null,
          };
          try {
            validateWorktreeSelectors({ intent: 'pr-checkout', pull });
          } catch {
            return sendJson(res, 502, { ok: false, error: 'forge returned unsafe pull request identity' });
          }
        }
        const mainRoot = await mainRepoRootOf(auth.cwd);
        // freshness: give the origin refs a bounded 4 s head start so the
        // default remote base is the true GitHub head (paseo relies on its
        // 180 s background fetch alone; the race never blocks or fails creation)
        try {
          if (await originUrl(mainRoot)) {
            const fetchPromise = runGit(['fetch', 'origin', '--prune'], {
              cwd: mainRoot,
              timeout: 120000,
            })
              .then((fetchResult) => {
                if (fetchResult.ok) hub.invalidate(auth.cwd);
              })
              .catch(() => {});
            await Promise.race([fetchPromise, new Promise((r) => setTimeout(r, 4000))]);
          }
        } catch {
          /* fetch is best-effort; creation proceeds regardless */
        }
        try {
          // `pull` switches creation to the PR-checkout intent (paseo's
          // checkout-change-request): the PR's head is fetched from the
          // forge's refs/pull/<N>/head and the PR's base becomes the diff
          // baseline. The branch-off/checkout paths above are untouched.
          const created = await createWorktree({
            repoRoot: mainRoot,
            base: body.base || undefined,
            intent,
            branchName: body.branchName || undefined,
            slug: body.slug || undefined,
            sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : undefined,
            pull,
          });
          return sendJson(res, 201, { ok: true, ...created });
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, 600);
          const status = /not allowed|does not exist|requires|cannot resolve|not a git repository|did not resolve to a commit/.test(message) ? 422 : 502;
          return sendJson(res, status, { ok: false, message });
        }
      }

      if (req.method === 'POST' && sub === '/worktrees/archive') {
        const body = await readBody(req);
        if (typeof body.path !== 'string' || body.path === '') {
          return sendJson(res, 400, { ok: false, error: 'path required' });
        }
        if (body.force !== undefined && typeof body.force !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'force must be boolean' });
        }
        const auth = await authorizeGit(res, body.path);
        if (!auth) return;
        const result = await archiveWorktree(auth.cwd, { force: Boolean(body.force) });
        return sendJson(res, result.ok ? 200 : worktreeFailureStatus(result), result);
      }

      if (req.method === 'POST' && sub === '/worktrees/cleanup') {
        const body = await readBody(req);
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd required' });
        }
        if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'dryRun must be boolean' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        if (!cleanup) return sendJson(res, 503, { ok: false, message: 'cleanup unavailable on this host build' });
        const cleanupRoot = await realpath(await mainRepoRootOf(auth.cwd));
        if (auth.kind !== 'workspace' || cleanupRoot !== auth.cwd) {
          return sendJson(res, 403, { ok: false, error: 'repo-wide cleanup requires the registered main checkout' });
        }
        const report = await cleanup({
          cwd: cleanupRoot,
          dryRun: Boolean(body.dryRun),
        });
        return sendJson(res, report.ok ? 200 : 500, report);
      }

      /* ---------------- snapshots + SSE ---------------- */
      if (req.method === 'POST' && sub === '/snapshots') {
        const body = await readBody(req);
        if (!Array.isArray(body.cwds)) return sendJson(res, 400, { ok: false, error: 'cwds array required' });
        const selectors = body.cwds;
        if (selectors.some((selector) => typeof selector !== 'string' || selector === '')) {
          return sendJson(res, 400, { ok: false, error: 'cwds must contain paths' });
        }
        if (selectors.length > 200) return sendJson(res, 413, { ok: false, error: 'too many workspaces' });
        const authorized = [];
        for (const selector of selectors) {
          const auth = await authorizeGit(res, selector, { allowNonGit: true });
          if (!auth) return;
          authorized.push(auth.cwd);
        }
        const byCwd = await hub.snapshots(authorized);
        return sendJson(res, 200, { ok: true, byCwd });
      }

      if (req.method === 'GET' && sub === '/snapshot') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd, { allowNonGit: true });
        if (!auth) return;
        // explicit single-target request: always fresh (batch /snapshots keeps the 3 s cache)
        const snapshot = await hub.snapshotFor(auth.cwd, { fresh: true });
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
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        const modeRaw = query.get('mode');
        if (modeRaw !== null && !['uncommitted', 'session', 'base', 'task'].includes(modeRaw)) {
          return sendJson(res, 422, { ok: false, error: 'invalid diff mode' });
        }
        // Shared-workspace session mode requests the uncommitted superset;
        // the client then filters it by transcript-touched literal paths.
        const mode = modeRaw === 'session' ? 'uncommitted' : modeRaw || 'uncommitted';
        const commit = query.get('commit');
        const path = query.get('path') || undefined;
        const ignoreWhitespace = query.get('w') === '1';
        if (mode === 'task') {
          const meta = await readMetadata(auth.cwd).catch(() => null);
          if (!meta || !meta.baseRef) return sendJson(res, 409, { ok: false, error: 'task-base-missing' });
        }
        let result;
        try {
          result = commit
            ? await commitDiff(auth.cwd, commit, { ignoreWhitespace, path })
            : await computeDiff(auth.cwd, { mode, baseRef: query.get('base') || undefined, ignoreWhitespace, path });
        } catch (error) {
          if (error?.message === 'task-base-missing') return sendJson(res, 409, { ok: false, error: 'task-base-missing' });
          if (error?.message === 'commit oid not found') return sendJson(res, 404, { ok: false, error: error.message });
          if (/^invalid (?:base revision|stored base revision|commit oid|diff path)$/.test(error?.message || '')) {
            return sendJson(res, 422, { ok: false, error: error.message });
          }
          throw error;
        }
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (req.method === 'GET' && sub === '/commits') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        let refs;
        try {
          refs = await resolveDiffRefs(auth.cwd, { mode: 'base', baseRef: query.get('base') || undefined });
        } catch (error) {
          if (/^invalid /.test(error?.message || '')) return sendJson(res, 422, { ok: false, error: error.message });
          throw error;
        }
        const commitResult = await listCommits(auth.cwd, `${refs.baseRef}..HEAD`, 200);
        if (!commitResult.ok) {
          return sendJson(res, 500, {
            ok: false,
            error: 'git-inspection-failed',
            stage: 'commits',
            message: String(commitResult.error || 'git log failed').trim().slice(0, 600),
          });
        }
        const commits = commitResult.commits;
        const branchInfo = await currentBranchInfo(auth.cwd);
        let remoteRef = null;
        if (branchInfo.branch) {
          const up = await upstreamInfo(auth.cwd, branchInfo.branch);
          if (up.upstreamRef) remoteRef = up.upstreamRef;
          else if (await hasRemoteBranch(auth.cwd, branchInfo.branch)) remoteRef = `refs/remotes/origin/${branchInfo.branch}`;
        }
        const unpushed = remoteRef ? await unpushedShas(auth.cwd, remoteRef) : null;
        const pushedSet = unpushed && unpushed.ok ? unpushed.shas : null;
        return sendJson(res, 200, {
          ok: true,
          base: refs.label,
          baseRef: refs.baseRef,
          remoteRef,
          commits: commits.map((commitItem) => ({
            ...commitItem,
            // Unknown/no remote is conservative: never label a commit pushed.
            unpushed: pushedSet ? pushedSet.has(commitItem.sha) : true,
          })),
          ...(unpushed && !unpushed.ok ? { degraded: ['unpushed'] } : {}),
        });
      }

      /* ---------------- actions ---------------- */
      if (req.method === 'GET' && sub === '/actions') {
        const cwd = query.get('cwd');
        if (!cwd) return sendJson(res, 400, { ok: false, error: 'cwd required' });
        const auth = await authorizeGit(res, cwd);
        if (!auth) return;
        // the ladder drives destructive buttons — always compute fresh
        const snapshot = await hub.snapshotFor(auth.cwd, { fresh: true });
        const ladder = buildActionLadder(snapshot, { agentRunning: query.get('running') === '1' });
        return sendJson(res, 200, { ok: true, ladder, snapshot });
      }

      if (req.method === 'POST' && sub === '/action') {
        const body = await readBody(req);
        if (typeof body.cwd !== 'string' || body.cwd === '' || typeof body.name !== 'string' || body.name === '') {
          return sendJson(res, 400, { ok: false, error: 'cwd and name required' });
        }
        if (body.params !== undefined && (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) {
          return sendJson(res, 400, { ok: false, error: 'params must be an object' });
        }
        const auth = await authorizeGit(res, body.cwd);
        if (!auth) return;
        const params = body.params ?? {};
        if (body.name === 'archive' && params.force !== undefined && typeof params.force !== 'boolean') {
          return sendJson(res, 400, { ok: false, error: 'force must be boolean' });
        }
        if (body.name === 'archive' && params.path !== undefined) {
          const pathAuth = await authorizer.authorize(params.path);
          if (!pathAuth.ok || pathAuth.cwd !== auth.cwd) {
            return sendJson(res, 403, { ok: false, error: 'archive path does not match authorized cwd' });
          }
        }
        const result = await executeAction(hub, auth.cwd, body.name, params, {
          authorizeTarget: async (candidate) => {
            const target = await authorizer.authorize(candidate);
            return target.ok && target.gitBoundary === 'root';
          },
        });
        const status = result?.ok ? 200 : result?.reasonKey === 'actions.unknown' ? 400 : actionFailureStatus(body.name, result);
        return sendJson(res, status, result ?? { ok: false });
      }

      /* ---------------- file editor ---------------- */
      if (req.method === 'GET' && sub === '/file') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') return sendJson(res, 400, { ok: false, error: 'cwd and path required' });
        const auth = await authorize(res, cwd);
        if (!auth) return;
        const located = await existingPathWithin(auth, rel);
        if (!located.ok) {
          if (located.status === 404) return sendJson(res, 404, { ok: true, kind: 'missing' });
          return sendJson(res, located.status, { ok: false, error: located.error });
        }
        const file = located.file;
        let opened;
        try {
          opened = await openRegularFile(auth, located);
        } catch {
          return sendJson(res, 403, { ok: false, error: 'path unavailable' });
        }
        if (!opened) return sendJson(res, 422, { ok: true, kind: 'not-file' });
        const { handle, stat: fileStat } = opened;
        try {
          const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
          if (IMAGE_EXT.has(ext)) {
            const encoded = rel.split('/').map(encodeURIComponent).join('/');
            return sendJson(res, 200, {
              ok: true,
              kind: 'image',
              size: fileStat.size,
              url: `${API_PREFIX}/raw?cwd=${encodeURIComponent(cwd)}&path=${encoded}`,
            });
          }
          if (fileStat.size > TEXT_MAX_BYTES) {
            return sendJson(res, 413, { ok: true, kind: 'too_large', size: fileStat.size });
          }
          const buffer = await readCapped(handle, TEXT_MAX_BYTES);
          if (!buffer) return sendJson(res, 413, { ok: true, kind: 'too_large', size: fileStat.size });
          const head = buffer.subarray(0, 8000);
          if (head.includes(0)) return sendJson(res, 415, { ok: true, kind: 'binary', size: fileStat.size });
          // sha1 lets the editor's POST /file do compare-and-swap on save
          return sendJson(res, 200, {
            ok: true,
            kind: 'text',
            size: fileStat.size,
            content: buffer.toString('utf8'),
            sha1: createHash('sha1').update(buffer).digest('hex'),
          });
        } finally {
          await handle.close().catch(() => {});
        }
      }

      if (req.method === 'POST' && sub === '/file') {
        const body = await readBody(req);
        const cwd = body && body.cwd;
        const rel = body && body.path;
        const content = body && body.content;
        const baseSha1 = body && body.baseSha1;
        if (!cwd || !rel || typeof content !== 'string') {
          return sendJson(res, 400, {
            ok: false,
            error: 'cwd, path and content required',
            message: 'cwd, path and content required',
          });
        }
        if (content.includes('\0')) {
          return sendJson(res, 415, { ok: false, error: 'binary content rejected', message: 'binary content rejected' });
        }
        const auth = await authorize(res, cwd);
        if (!auth) return;
        const located = await existingPathWithin(auth, rel);
        if (!located.ok) {
          const error = located.status === 404 ? 'existing file required' : located.error;
          return sendJson(res, located.status, { ok: false, error, message: error });
        }
        if (typeof baseSha1 !== 'string' || !/^[0-9a-f]{40}$/i.test(baseSha1)) {
          return sendJson(res, 400, { ok: false, error: 'invalid baseSha1', message: 'invalid baseSha1' });
        }
        const file = located.file;
        let parent = null;
        let unlockFile = null;
        let tempName = null;
        let tempPath = null;
        let tempCleanupIdentity = null;
        let nextIdentity = null;
        let exchanged = false;
        try {
          unlockFile = await lockFileMutation(file);
          parent = await openAnchoredParent(auth, located);
          const name = basename(file);
          const current = await readAnchoredRegular(parent.anchor, name);
          if (!current) {
            return sendJson(res, 404, { ok: false, error: 'existing file required', message: 'existing file required' });
          }
          if (current.stat.size > TEXT_MAX_BYTES || !current.buffer) {
            return sendJson(res, 413, { ok: false, error: 'file too large', message: 'file too large' });
          }
          if (current.buffer.includes(0)) {
            return sendJson(res, 415, { ok: false, error: 'binary file rejected', message: 'binary file rejected' });
          }
          const currentSha1 = createHash('sha1').update(current.buffer).digest('hex');
          if (baseSha1 !== currentSha1) {
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk since it was loaded',
              sha1: currentSha1,
            });
          }

          const next = Buffer.from(content, 'utf8');
          tempName = `.bw-${randomUUID()}.tmp`;
          tempPath = `${parent.anchor}/${tempName}`;
          const temp = await open(
            tempPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            current.stat.mode & 0o777,
          );
          try {
            await temp.chmod(current.stat.mode & 0o777);
            await temp.writeFile(next);
            await temp.sync();
            nextIdentity = await temp.stat();
            tempCleanupIdentity = nextIdentity;
          } finally {
            await temp.close().catch(() => {});
          }
          if (!(await verifyOpenIdentity(parent.handle, auth, parent.lexicalParent))) {
            throw new ApiError(409, 'file path changed during save');
          }
          // Recheck CAS at the commit point after the potentially slow write.
          const latest = await readAnchoredRegular(parent.anchor, name);
          const latestSha1 = latest?.buffer ? createHash('sha1').update(latest.buffer).digest('hex') : null;
          if (!latest || latestSha1 !== baseSha1) {
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk since it was loaded',
              ...(latestSha1 ? { sha1: latestSha1 } : {}),
            });
          }
          await exchangeAnchored(parent.handle, tempName, name);
          exchanged = true;
          // The displaced target now lives at tempName. Verify the expected
          // value after the atomic exchange; a mismatch swaps it back before
          // returning conflict, so no concurrent pre-commit write is lost.
          const displaced = await readAnchoredRegular(parent.anchor, tempName);
          if (displaced) tempCleanupIdentity = displaced.stat;
          const displacedSha1 = displaced?.buffer ? createHash('sha1').update(displaced.buffer).digest('hex') : null;
          if (!displaced || displacedSha1 !== baseSha1) {
            await exchangeAnchored(parent.handle, tempName, name);
            exchanged = false;
            tempCleanupIdentity = nextIdentity;
            return sendJson(res, 409, {
              ok: false,
              error: 'conflict',
              message: 'file changed on disk during save',
              ...(displacedSha1 ? { sha1: displacedSha1 } : {}),
            });
          }
          const removedDisplaced = await removeMatchingIdentity(tempPath, tempCleanupIdentity);
          const recovery = removedDisplaced ? null : tempName;
          tempPath = null;
          exchanged = false;
          await parent.handle.sync();
          await hub.invalidate(auth.cwd);
          return sendJson(res, 200, {
            ok: true,
            sha1: createHash('sha1').update(next).digest('hex'),
            bytes: next.length,
            ...(recovery ? { recovery } : {}),
          });
        } catch (error) {
          let failure = error;
          if (exchanged && parent && tempName) {
            try {
              await exchangeAnchored(parent.handle, tempName, basename(file));
              exchanged = false;
              tempCleanupIdentity = nextIdentity;
            } catch (rollbackError) {
              // tempName contains the displaced original; retain it for manual
              // recovery instead of deleting the only pre-save copy.
              tempPath = null;
              failure = new Error(`${String(error?.message ?? error)}; rollback failed: ${String(rollbackError?.message ?? rollbackError)}`);
            }
          }
          const status = failure instanceof ApiError ? failure.status : ['ELOOP', 'ENOENT'].includes(failure?.code) ? 409 : 500;
          return sendJson(res, status, { ok: false, message: String(failure?.message ?? failure).slice(0, 300) });
        } finally {
          if (tempPath) await removeMatchingIdentity(tempPath, tempCleanupIdentity).catch(() => {});
          if (parent) await parent.handle.close().catch(() => {});
          unlockFile?.();
        }
      }

      if (req.method === 'GET' && sub === '/worktree-workspaces') {
        if (!worktreeWorkspaces) return sendJson(res, 200, { ok: true, items: [] });
        try {
          return sendJson(res, 200, { ok: true, items: await worktreeWorkspaces() });
        } catch (error) {
          return sendJson(res, 503, { ok: false, message: String(error?.message ?? error).slice(0, 300) });
        }
      }

      if (req.method === 'GET' && sub === '/raw') {
        const cwd = query.get('cwd');
        const rel = query.get('path') || '';
        if (!cwd || rel === '') {
          res.writeHead(400).end();
          return;
        }
        const auth = await authorizer.authorize(cwd);
        if (!auth.ok) {
          res.writeHead(auth.status || 403).end();
          return;
        }
        const located = await existingPathWithin(auth, rel);
        if (!located.ok) {
          res.writeHead(located.status).end();
          return;
        }
        const file = located.file;
        const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
        if (!IMAGE_EXT.has(ext)) {
          res.writeHead(415).end();
          return;
        }
        try {
          const opened = await openRegularFile(auth, located);
          if (!opened) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
            'Content-Length': opened.stat.size,
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'X-Content-Type-Options': 'nosniff',
          });
          const stream = opened.handle.createReadStream();
          await pipeline(stream, res);
        } catch {
          if (!res.headersSent) res.writeHead(404).end();
          else if (!res.writableEnded) res.destroy();
        }
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown route ${sub}` });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String(error?.message ?? error).slice(0, 400) });
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
