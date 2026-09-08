/**
 * worktree.js — managed-worktree lifecycle (paseo-inspired).
 *
 * Layout: `${DSH_HOME:-~/.dsh}/worktrees/<8-char base36 sha256(mainRepoRoot)>/<slug>`
 * with collision suffixes `-1`, `-2`, …. Identity/metadata lives at
 * `<worktree-gitdir>/dsh-worktree/worktree.json` (atomic tmp+rename writes):
 * baseRef (exact), baseRefName (display), intent, branch, slug, createdAt.
 * Only paths under our worktrees root WITH a metadata record are "managed"
 * and eligible for archive.
 */
import { createHash, randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import {
  hasLocalBranch,
  hasRemoteBranch,
  listWorktreesRaw,
  originUrl,
  runGit,
  safeRealpath,
} from './git.js';

export const METADATA_DIR = 'dsh-worktree';
export const METADATA_FILE = 'worktree.json';
export const METADATA_VERSION = 1;

export function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

export function worktreesRoot() {
  return join(dshHome(), 'worktrees');
}

/** Paseo's deriveShortAlphanumericHash: first 8 sha256 bytes → BigInt → base36 → 8 chars. */
export function projectHash(mainRepoRoot) {
  const digest = createHash('sha256').update(mainRepoRoot).digest();
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(digest[index] ?? 0);
  }
  return value.toString(36).padStart(13, '0').slice(0, 8);
}

export async function repoWorktreesRoot(mainRepoRoot) {
  const real = await safeRealpath(mainRepoRoot);
  return join(worktreesRoot(), projectHash(real));
}

function slugify(value, fallback = 'wt') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/[/]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

/** `<worktree-gitdir>/dsh-worktree/worktree.json` path for a worktree cwd. */
export async function metadataPathFor(worktreeCwd) {
  const r = await runGit(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: worktreeCwd });
  if (!r.ok) return null;
  return join(r.stdout.trim(), METADATA_DIR, METADATA_FILE);
}

export async function readMetadata(worktreeCwd) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeMetadata(worktreeCwd, metadata) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) throw new Error('worktree: cannot resolve gitdir for metadata');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(metadata, null, 2), 'utf8');
  await rename(tmp, file);
}

/** Append `-1`, `-2`, … until refs/heads/<name> does not exist (paseo's resolveUniqueLocalBranchName). */
export async function uniqueLocalBranchName(repoRoot, wanted) {
  let candidate = wanted;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    if (!(await hasLocalBranch(repoRoot, candidate))) return candidate;
    candidate = `${wanted}-${suffix}`;
  }
  throw new Error(`worktree: cannot uniquify branch name ${JSON.stringify(wanted)}`);
}

/** Append `-1`, `-2`, … until the directory does not exist. */
async function uniquePath(base) {
  let candidate = base;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
    candidate = `${base}-${suffix}`;
  }
  throw new Error(`worktree: cannot uniquify path ${JSON.stringify(base)}`);
}

/* paseo createNameId equivalent: adj-noun-hhhh, always a valid branch slug.
 * Mirrors the client-side generator (the bundle cannot import host modules). */
const MNEMONIC_ADJ = ['amber', 'brave', 'calm', 'clever', 'coral', 'cosmic', 'crimson', 'curious', 'daring', 'dusty', 'eager', 'electric', 'emerald', 'fading', 'fierce', 'floating', 'gentle', 'gilded', 'golden', 'hidden', 'hollow', 'humble', 'icy', 'indigo', 'iron', 'ivory', 'jagged', 'jolly', 'keen', 'lively', 'lunar', 'mellow', 'misty', 'molten', 'muted', 'nifty', 'nimble', 'noble', 'pale', 'patient', 'polar', 'proud', 'quiet', 'radiant', 'rapid', 'rustic', 'sage', 'scarlet', 'serene', 'shadow', 'shifting', 'silent', 'silver', 'solar', 'solid', 'somber', 'swift', 'tender', 'tranquil', 'umber', 'vast', 'velvet', 'vivid', 'wandering', 'warm', 'wild', 'winter', 'witty', 'zealous'];
const MNEMONIC_NOUN = ['anchor', 'arrow', 'aurora', 'badger', 'basalt', 'beacon', 'birch', 'blossom', 'brook', 'canyon', 'cedar', 'cinder', 'cipher', 'cliff', 'comet', 'copper', 'creek', 'crest', 'crystal', 'current', 'dawn', 'delta', 'dune', 'ember', 'estuary', 'falcon', 'fen', 'fjord', 'flint', 'forest', 'forge', 'fossil', 'gale', 'galaxy', 'garden', 'geode', 'glacier', 'glade', 'granite', 'grove', 'harbor', 'heron', 'horizon', 'island', 'ivy', 'lagoon', 'lantern', 'larch', 'lava', 'leaf', 'lynx', 'marsh', 'meadow', 'meteor', 'monsoon', 'moss', 'nebula', 'oak', 'oasis', 'opal', 'orbit', 'otter', 'peak', 'pebble', 'pine', 'prairie', 'quartz', 'quill', 'raven', 'reef', 'ridge', 'river', 'rose', 'sable', 'sequoia', 'shoal', 'sparrow', 'spring', 'steppe', 'stone', 'summit', 'talon', 'thicket', 'tide', 'timber', 'tundra', 'vale', 'vine', 'walrus', 'willow', 'wolf', 'wren', 'yarrow'];

export function mnemonicSlug() {
  const adj = MNEMONIC_ADJ[randomInt(MNEMONIC_ADJ.length)];
  const noun = MNEMONIC_NOUN[randomInt(MNEMONIC_NOUN.length)];
  const hex = randomInt(0x10000).toString(16).padStart(4, '0');
  return `${adj}-${noun}-${hex}`;
}

/**
 * Read-modify-write the managed-worktree metadata atomically.
 * No-op (returns false) when the path carries no metadata record.
 */
export async function patchMetadata(worktreeCwd, mutator) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) return false;
  let current;
  try {
    current = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return false;
  }
  const next = mutator(current);
  if (!next || next === current) return false;
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  return true;
}

/**
 * Create one managed worktree.
 *
 * @param opts.repoRoot   any cwd inside the MAIN repository (worktrees are always cut from the main checkout's refs)
 * @param opts.base       base branch name to cut from (default branch when omitted)
 * @param opts.intent     'checkout' — check out an existing branch (unique copy branch when it is
 *                        already checked out elsewhere; remote-only branches are fetched first);
 *                        'branch-off' — create a NEW branch based on `base`.
 * @param opts.branchName for 'checkout': the existing branch; for 'branch-off': desired new branch name
 *                        (uniquified automatically).
 * @param opts.slug       directory slug (derived from branchName when omitted).
 * @returns {Promise<{path:string, branch:string, baseRef:string, baseRefName:string, copiedFrom:string|null}>}
 */
export async function createWorktree(opts) {
  const { repoRoot, base, intent = 'checkout', branchName, slug, sourceTitle } = opts;
  if (!repoRoot) throw new Error('worktree: repoRoot is required');
  const detect = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (!detect.ok) throw new Error(`worktree: ${repoRoot} is not a git repository`);
  const mainRoot = await mainRepoRootOf(repoRoot);
  const rawBase = base || (await defaultBranchOf(mainRoot));
  if (!rawBase) throw new Error('worktree: cannot resolve a base branch (empty repository?)');
  // exact refs (the picker sends refs/heads/x or refs/remotes/origin/x —
  // paseo resolveBaseBranchForWorktree parity) verify and are used as-is;
  // bare names keep the origin-first fallback
  let baseName;
  let baseRef = null;
  if (typeof rawBase === 'string' && rawBase.startsWith('refs/')) {
    const verify = await runGit(['rev-parse', '--verify', '--quiet', rawBase], { cwd: mainRoot });
    if (!verify.ok) throw new Error(`worktree: base ref ${JSON.stringify(rawBase)} does not exist`);
    baseRef = rawBase;
    baseName = rawBase.startsWith('refs/heads/')
      ? rawBase.slice('refs/heads/'.length)
      : rawBase.startsWith('refs/remotes/origin/')
        ? rawBase.slice('refs/remotes/origin/'.length)
        : rawBase;
  } else {
    baseName = rawBase;
    if (await hasRemoteBranch(mainRoot, baseName)) baseRef = `refs/remotes/origin/${baseName}`;
    else if (await hasLocalBranch(mainRoot, baseName)) baseRef = `refs/heads/${baseName}`;
    else {
      const verify = await runGit(['rev-parse', '--verify', '--quiet', baseName], { cwd: mainRoot });
      if (!verify.ok) throw new Error(`worktree: base branch ${JSON.stringify(baseName)} does not exist`);
      baseRef = baseName;
    }
  }
  const baseSha = (await runGit(['rev-parse', baseRef], { cwd: mainRoot })).stdout.trim();

  const root = await repoWorktreesRoot(mainRoot);
  await mkdir(root, { recursive: true });

  let finalBranch;
  let copiedFrom = null;
  let autoNameEligible = false;
  let addArgs; // args AFTER `git worktree add <path>`
  const existing = await listWorktreesRaw(mainRoot);
  const checkedOutBranches = new Set(existing.map((w) => w.branch).filter(Boolean));

  if (intent === 'branch-off') {
    // paseo semantics: placeholder branch cut from the base — seeded by the
    // caller's slug (mnemonic) when no explicit branch name was requested;
    // slugless callers get a server-side mnemonic. Explicit names are final.
    const wanted = branchName || (slug ? slugify(slug) : '') || mnemonicSlug();
    autoNameEligible = !branchName;
    finalBranch = await uniqueLocalBranchName(mainRoot, wanted);
    addArgs = ['-b', finalBranch, '--no-track', baseRef];
  } else {
    // checkout intent
    const target = branchName || baseName;
    if (await hasLocalBranch(mainRoot, target)) {
      if (checkedOutBranches.has(target)) {
        // branch already checked out elsewhere → unique copy branch (paseo behavior)
        copiedFrom = target;
        finalBranch = await uniqueLocalBranchName(mainRoot, target);
        addArgs = ['-b', finalBranch, '--no-track', `refs/heads/${target}`];
      } else {
        finalBranch = target;
        addArgs = [target];
      }
    } else if (await hasRemoteBranch(mainRoot, target)) {
      // remote-only → materialize a local branch first (paseo: git fetch origin b:b)
      const fetch = await runGit(['fetch', 'origin', `${target}:${target}`], {
        cwd: mainRoot,
        timeout: 120000,
      });
      if (!fetch.ok) throw new Error(`worktree: fetch of origin/${target} failed: ${fetch.stderr.trim()}`);
      if (checkedOutBranches.has(target)) {
        copiedFrom = target;
        finalBranch = await uniqueLocalBranchName(mainRoot, target);
        addArgs = ['-b', finalBranch, '--no-track', `refs/heads/${target}`];
      } else {
        finalBranch = target;
        addArgs = [target];
      }
    } else {
      throw new Error(`worktree: branch ${JSON.stringify(target)} exists neither locally nor on origin`);
    }
  }

  const finalPath = await uniquePath(join(root, slugify(slug || finalBranch)));
  // git worktree add <path> [-b <new> --no-track <base> | <branch>]
  const result = await runGit(['worktree', 'add', finalPath, ...addArgs], {
    cwd: mainRoot,
    timeout: 120000,
  });
  if (!result.ok) {
    throw new Error(`worktree: git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const metadata = {
    version: METADATA_VERSION,
    baseRef: baseSha || baseRef,
    baseRefName: baseName,
    intent,
    branch: finalBranch,
    copiedFrom,
    slug: basename(finalPath),
    mainRepoRoot: mainRoot,
    createdAt: Date.now(),
    // sidebar-title provenance: the workspace the session was launched from
    ...(typeof sourceTitle === 'string' && sourceTitle.trim()
      ? { sourceWorkspaceTitle: sourceTitle.trim().slice(0, 100) }
      : {}),
    // first-message LLM rename eligibility (ADR 0004): only auto-placeholder
    // branches are rename candidates; user-chosen names are final
    ...(intent === 'branch-off'
      ? {
          autoName: autoNameEligible
            ? { status: 'pending', placeholder: finalBranch }
            : { status: 'ineligible' },
        }
      : {}),
  };
  await writeMetadata(finalPath, metadata);
  return { path: finalPath, branch: finalBranch, baseRef: baseSha, baseRefName: baseName, copiedFrom };
}

/** Main repo root for any cwd inside the repo/worktree family (git-common-dir is `<main>/.git[/worktrees/<name>]`… the shared dir itself). */
export async function mainRepoRootOf(cwd) {
  const common = await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (!common.ok) return cwd;
  return dirname(common.stdout.trim());
}

async function defaultBranchOf(mainRoot) {
  const sym = await runGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
    cwd: mainRoot,
  });
  const ref = sym.stdout.trim();
  if (sym.ok && ref) {
    const short = ref.replace(/^refs\/remotes\/origin\//, '');
    return short;
  }
  for (const candidate of ['main', 'master']) {
    if (await hasLocalBranch(mainRoot, candidate)) return candidate;
    if (await hasRemoteBranch(mainRoot, candidate)) return candidate;
  }
  const head = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: mainRoot });
  return head.ok && head.stdout.trim() ? head.stdout.trim() : null;
}

/**
 * List worktrees of a repo, enriched with managed flag + metadata.
 * `currentCwd` marks the entry the caller is standing in.
 */
export async function listManagedWorktrees(repoRoot, currentCwd) {
  const mainRoot = await mainRepoRootOf(repoRoot);
  const raw = await listWorktreesRaw(mainRoot);
  const root = await repoWorktreesRoot(mainRoot);
  const realCurrent = currentCwd ? await safeRealpath(currentCwd) : null;
  const realMain = await safeRealpath(mainRoot);
  const items = [];
  for (const entry of raw) {
    const real = await safeRealpath(entry.path);
    const underRoot = real.startsWith(root + '/') || entry.path.startsWith(root + '/');
    let metadata = null;
    if (underRoot) metadata = await readMetadata(entry.path).catch(() => null);
    let createdAt = null;
    try {
      createdAt = (await stat(entry.path)).mtimeMs;
    } catch {
      /* gone */
    }
    items.push({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      detached: entry.detached,
      bare: entry.bare,
      managed: Boolean(underRoot && metadata),
      baseRefName: metadata?.baseRefName ?? null,
      createdAt,
      current: realCurrent !== null && real === realCurrent,
      isMain: real === realMain,
    });
  }
  return { mainRepoRoot: mainRoot, root, items };
}

/**
 * Archive (remove) one MANAGED worktree. Ownership: path must live under our
 * worktrees root and carry a metadata record. Refuses dirty/unpushed worktrees
 * unless `force`. Runs teardown best-effort: `git worktree remove --force`,
 * then rm -rf retry ladder, then `git worktree prune`.
 */
export async function archiveWorktree(path, opts = {}) {
  const { force = false } = opts;
  const real = await safeRealpath(path);
  const root = worktreesRoot();
  if (!(real.startsWith(root + '/') || path.startsWith(root + '/'))) {
    return { ok: false, reason: 'not-managed', message: '仅托管 worktree 可归档（路径不在 worktrees 根下）' };
  }
  const metadata = await readMetadata(path);
  if (!metadata) {
    return { ok: false, reason: 'not-managed', message: '仅托管 worktree 可归档（缺少元数据记录）' };
  }
  if (!force) {
    const status = await runGit(['status', '--porcelain'], { cwd: path });
    const dirty = status.ok && status.stdout.trim() !== '';
    const branch = metadata.branch;
    let unpushed = 0;
    if (branch) {
      const remoteRef = (await hasRemoteBranch(path, branch)) ? `refs/remotes/origin/${branch}` : null;
      if (remoteRef) {
        const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], { cwd: path });
        unpushed = Number(ahead.stdout.trim()) || 0;
      } else {
        // No same-name remote branch. Counting EVERY commit (old rule) made
        // clean fresh worktrees unarchivable in repos whose origin lacks the
        // branch: count commits no origin ref carries instead; without any
        // origin fall back to the recorded base ref (unique-commit count).
        const hasOrigin = (await originUrl(path)) !== null;
        const range = hasOrigin ? ['HEAD', '--not', '--remotes=origin'] : [`${metadata.baseRef || 'HEAD'}..HEAD`];
        const count = await runGit(['rev-list', '--count', ...range], { cwd: path });
        unpushed = Number(count.stdout.trim()) || 0;
      }
    }
    if (dirty || unpushed > 0) {
      const parts = [];
      if (dirty) parts.push('未提交改动');
      if (unpushed > 0) parts.push(`${unpushed} 个未推送提交`);
      return {
        ok: false,
        reason: 'unsafe',
        dirty,
        unpushed,
        message: `worktree 有${parts.join('、')}`,
      };
    }
  }
  const mainRoot = metadata.mainRepoRoot || (await mainRepoRootOf(path));
  await runGit(['worktree', 'remove', path, '--force'], { cwd: mainRoot, timeout: 60000, allowFail: true });
  for (const delay of [0, 100, 300, 700, 1500]) {
    try {
      await rm(path, { recursive: true, force: true });
      break;
    } catch {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  await runGit(['worktree', 'prune'], { cwd: mainRoot, allowFail: true });
  return { ok: true, path, branch: metadata.branch };
}
