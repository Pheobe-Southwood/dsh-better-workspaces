/**
 * stable.js — platform capability layer for stable workspace operations.
 *
 * Linux keeps the strongest anchoring this plugin has ever had: directory
 * dirfds bridge every Git invocation and file write through /proc/<pid>/fd,
 * and file saves commit through renameat2(RENAME_EXCHANGE) with displaced-
 * inode verification. Every other platform (Windows, macOS) runs the paseo
 * model: canonical paths for Git discovery, stat dev/ino identity checks at
 * operation boundaries, no GIT_DIR pinning, and fsync + CAS + rename saves.
 *
 * All platform branching in lib/ funnels through here so tests can simulate
 * a foreign platform on POSIX CI (ADR 0013).
 */
import { open, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';

const state = { override: null };

/**
 * Test-only platform override. Pass `null` (or the real `process.platform`)
 * to restore; a simulated platform must be restored before the process
 * handles real work again.
 */
export function __setPlatformForTests(platform) {
  state.override = typeof platform === 'string' && platform !== process.platform ? platform : null;
}

/** Effective platform: the test override, else the real one. */
export function currentPlatform() {
  return state.override || process.platform;
}

/** /proc dirfd anchoring exists only on Linux. */
export function isDirfdPinSupported() {
  return currentPlatform() === 'linux';
}

/** renameat2(RENAME_EXCHANGE) via GNU `mv --exchange` exists only on Linux. */
export function isFileExchangeSupported() {
  return currentPlatform() === 'linux';
}

export function isWindows() {
  return currentPlatform() === 'win32';
}

/**
 * Open flags for directories. Only the dirfd mode opens directories at all;
 * win32 cannot combine O_DIRECTORY/O_NOFOLLOW portably (paseo precedent), so
 * it gets plain O_RDONLY while POSIX keeps the hardened set.
 */
export function directoryOpenFlags() {
  return isWindows()
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

/** Open flags for reading a regular file; O_NOFOLLOW is POSIX-only here. */
export function fileOpenFlags() {
  return isWindows() ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
}

/** Open flags for the file editor's exclusive temp creation. */
export function fileCreateFlags() {
  return isWindows()
    ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
}

/** /proc magic-link for one open descriptor (dirfd mode only). */
export function procFdPath(handle) {
  return `/proc/${process.pid}/fd/${handle.fd}`;
}

const WINDOWS_SHAPED_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/;

/**
 * Normalize a path printed by Git. Git on Windows prints forward slashes
 * (`C:/Users/…`, `//server/share/…`); realpath-derived paths use backslashes,
 * so raw string comparisons fail. Conversion is driven by the path's shape —
 * not by the host platform — which keeps the helper faithful on POSIX hosts
 * and under the simulated-platform tests (paseo's normalizePathForOwnership).
 */
export function normalizeGitPath(value) {
  if (typeof value !== 'string' || value === '') return value;
  if (!WINDOWS_SHAPED_PATH.test(value)) return value;
  return value.replace(/\//g, '\\');
}

/**
 * Filesystem-equivalent path comparison: exact strings on POSIX, case- and
 * separator-normalized on win32 (NTFS/ReFS preserve case but do not honor it).
 */
export function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return left === right;
  if (left === right) return true;
  if (!isWindows()) return false;
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

/**
 * Path-mode anchor verification: the directory at `path` must still be the
 * exact inode authorization captured. This is the paseo-model replacement
 * for holding a dirfd (ADR 0013).
 */
export async function verifyStatIdentity(path, expected) {
  if (typeof path !== 'string' || path === '') return false;
  if (!expected || typeof expected.dev !== 'number' || typeof expected.ino !== 'number') return false;
  try {
    const info = await stat(path);
    return info.dev === expected.dev && info.ino === expected.ino;
  } catch {
    return false;
  }
}

/**
 * Same check for callers that hold dev/ino as separate optional fields; a
 * missing expectation degrades to an existence check (the dirfd mode treats
 * an unopened expectation the same way).
 */
export async function verifyStatIdentityFields(path, dev, ino) {
  if (typeof dev !== 'number' || typeof ino !== 'number') {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }
  return verifyStatIdentity(path, { dev, ino });
}

/**
 * Durable directory sync hint after metadata/journal publication. Windows
 * cannot fsync a read-only directory handle, so it becomes a no-op there;
 * POSIX (Linux and macOS) keeps the open + fsync contract.
 */
export async function syncDirectory(path) {
  if (isWindows()) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
