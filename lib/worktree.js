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
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import {
  detectRepo,
  hasLocalBranch,
  hasRemoteBranch,
  listWorktreesRaw,
  originUrl,
  remoteUrl,
  runGit,
  safeRealpath,
} from './git.js';

export const METADATA_DIR = 'dsh-worktree';
export const METADATA_FILE = 'worktree.json';
export const METADATA_VERSION = 1;
const METADATA_MAX_BYTES = 64 * 1024;

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

async function requireDirectDirectory(path, label) {
  try {
    const [info, canonical] = await Promise.all([lstat(path), realpath(path)]);
    if (!info.isDirectory() || info.isSymbolicLink() || canonical !== path) throw new Error('rebound');
  } catch {
    throw new Error(`worktree: ${label} is unavailable or rebound`);
  }
}

async function prepareManagedRoot(mainRoot) {
  const globalRoot = worktreesRoot();
  await mkdir(globalRoot, { recursive: true });
  await requireDirectDirectory(globalRoot, 'managed root');
  const root = await repoWorktreesRoot(mainRoot);
  try {
    await mkdir(root);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await requireDirectDirectory(root, 'repository managed root');
  return root;
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

async function readCapped(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(8192, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
    if (bytesRead === 0) return Buffer.concat(chunks, offset);
    chunks.push(chunk.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return null;
}

export async function readMetadata(worktreeCwd) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) return null;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > METADATA_MAX_BYTES) return null;
    const data = await readCapped(handle, METADATA_MAX_BYTES);
    return data ? JSON.parse(data.toString('utf8')) : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pathIsInside(root, target) {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Strong ownership proof shared by API authorization, listing, state and cleanup. */
export async function validateManagedWorktree(path, { expectedMainRoot } = {}) {
  let cwd;
  try {
    cwd = await realpath(path);
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, reason: 'path-unavailable' };
  }
  const detected = await detectRepo(cwd);
  if (!detected.isGit || !detected.isLinkedWorktree) return { ok: false, reason: 'not-linked-worktree' };
  let repoRoot;
  let detectedMain;
  try {
    repoRoot = await realpath(detected.repoRoot);
    detectedMain = await realpath(detected.mainRepoRoot);
  } catch {
    return { ok: false, reason: 'repo-unavailable' };
  }
  if (repoRoot !== cwd) return { ok: false, reason: 'not-worktree-root' };

  const metadata = await readMetadata(cwd).catch(() => null);
  if (!metadata || metadata.version !== METADATA_VERSION) return { ok: false, reason: 'metadata-invalid' };
  if (!isValidBranchName(metadata.branch) || !['branch-off', 'checkout', 'pr-checkout'].includes(metadata.intent)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  if (metadata.baseRefName !== null && metadata.baseRefName !== undefined && !isValidBranchName(metadata.baseRefName)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  if (metadata.baseRef !== null && metadata.baseRef !== undefined && !FULL_OID.test(metadata.baseRef)) {
    return { ok: false, reason: 'metadata-invalid' };
  }
  let metadataMain;
  try {
    metadataMain = await realpath(metadata.mainRepoRoot);
  } catch {
    return { ok: false, reason: 'metadata-main-unavailable' };
  }
  if (metadataMain !== detectedMain) return { ok: false, reason: 'metadata-main-mismatch' };
  if (expectedMainRoot) {
    try {
      if ((await realpath(expectedMainRoot)) !== metadataMain) return { ok: false, reason: 'source-not-authorized' };
    } catch {
      return { ok: false, reason: 'source-not-authorized' };
    }
  }
  const globalRoot = worktreesRoot();
  const ownedRoot = await repoWorktreesRoot(metadataMain);
  try {
    const [globalReal, ownedReal, ownedStat] = await Promise.all([
      realpath(globalRoot),
      realpath(ownedRoot),
      lstat(ownedRoot),
    ]);
    if (globalReal !== globalRoot || ownedReal !== ownedRoot || ownedStat.isSymbolicLink()) {
      return { ok: false, reason: 'managed-root-rebound' };
    }
  } catch {
    return { ok: false, reason: 'managed-root-unavailable' };
  }
  if (!pathIsInside(ownedRoot, cwd)) return { ok: false, reason: 'outside-managed-root' };

  const listed = await listWorktreesRaw(metadataMain);
  for (const entry of listed) {
    try {
      if (!entry.bare && (await realpath(entry.path)) === cwd) {
        return { ok: true, cwd, root: cwd, mainRepoRoot: metadataMain, metadata };
      }
    } catch {
      /* stale worktree rows are not ownership evidence */
    }
  }
  return { ok: false, reason: 'not-in-git-worktree-list' };
}

async function writeMetadata(worktreeCwd, metadata) {
  const file = await metadataPathFor(worktreeCwd);
  if (!file) throw new Error('worktree: cannot resolve gitdir for metadata');
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tmp, file);
    const directory = await open(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      await directory.sync();
    } finally {
      await directory.close().catch(() => {});
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  }
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
  const current = await readMetadata(worktreeCwd);
  if (!current) return false;
  const next = mutator(current);
  if (!next || next === current) return false;
  await writeMetadata(worktreeCwd, next);
  return true;
}

/**
 * Create one managed worktree.
 *
 * @param opts.repoRoot   any cwd inside the MAIN repository (worktrees are always cut from the main checkout's refs)
 * @param opts.base       base branch name to cut from (default branch when omitted)
 * @param opts.intent     'checkout' — check out an existing branch (unique copy branch when it is
 *                        already checked out elsewhere; remote-only branches are fetched first);
 *                        'branch-off' — create a NEW branch based on `base`;
 *                        'pr-checkout' — materialize one pull request's head as a local branch
 *                        (paseo's checkout-change-request; `opts.pull` is required).
 * @param opts.branchName for 'checkout': the existing branch; for 'branch-off': desired new branch name
 *                        (uniquified automatically).
 * @param opts.slug       directory slug (derived from branchName when omitted).
 * @param opts.pull       'pr-checkout' only: {number, headRef, baseRef, forkOwner} — the PR to check out.
 *                        `forkOwner` set means a cross-repository (fork) PR: the local branch is
 *                        named `<owner>/<headRef>` and no upstream is configured (paseo parity).
 * @returns {Promise<{path:string, branch:string, baseRef:string, baseRefName:string, copiedFrom:string|null}>}
 */
/**
 * Best-effort base for PR metadata: a syntactically safe branch may disappear
 * without blocking checkout, but arbitrary refs/revision expressions fail.
 */
async function resolveBaseTolerant(mainRoot, rawBase) {
  if (!isValidBaseSelector(rawBase)) throw new Error(`worktree: base ${JSON.stringify(rawBase)} is not allowed`);
  try {
    return await resolveBase(mainRoot, rawBase);
  } catch {
    return { baseName: null, baseRef: null };
  }
}

/**
 * Local branch name one PR head will occupy. paseo's buildPrLocalBranchName:
 * GitHub prefixes the fork owner so a cross-repository head cannot collide
 * with a local branch of the same name. The name is only *chosen* here —
 * `git worktree add -b <name>` creates it — so a taken name uniquifies
 * (`<name>-1`, …) exactly like the branch-off path.
 */
async function anchorLocalBranchName(mainRoot, forkOwner, headRef) {
  const owner = typeof forkOwner === 'string' ? forkOwner.trim().replace(/[^A-Za-z0-9._-]+/g, '-') : '';
  const wanted = owner ? `${owner}/${headRef}` : headRef;
  if (!isValidBranchName(wanted)) {
    throw new Error(`worktree: PR head ${JSON.stringify(headRef)} is not a usable branch name`);
  }
  return uniqueLocalBranchName(mainRoot, wanted);
}

/**
 * git check-ref-format's rules, applied to a branch name we are about to have
 * git create (`git worktree add -b`): a rejected name should surface as our
 * message naming the PR head, not as git's plumbing error.
 */
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function isValidBranchName(name) {
  if (typeof name !== 'string' || name === '' || name === '@' || name.length > 255) return false;
  if (name.startsWith('/') || name.startsWith('-') || name.endsWith('/') || name.endsWith('.')) return false;
  if (name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (name.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))) return false;
  // eslint-disable-next-line no-control-regex -- git forbids these bytes in refs
  return !/[\s~^:?*[\]\\\u0000-\u001f\u007f]/.test(name);
}

function isValidBaseSelector(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (FULL_OID.test(value)) return true;
  for (const prefix of ['refs/heads/', 'refs/remotes/origin/']) {
    if (value.startsWith(prefix)) return isValidBranchName(value.slice(prefix.length));
  }
  return isValidBranchName(value);
}

export function validateWorktreeSelectors({ base, branchName, intent = 'checkout', pull } = {}) {
  if (base !== undefined && !isValidBaseSelector(base)) {
    throw new Error(`worktree: base ${JSON.stringify(base)} is not allowed`);
  }
  if (branchName !== undefined && !isValidBranchName(branchName)) {
    throw new Error(`worktree: branch ${JSON.stringify(branchName)} is not allowed`);
  }
  if (intent === 'pr-checkout') {
    if (!pull || !Number.isSafeInteger(pull.number) || pull.number <= 0 || !isValidBranchName(pull.headRef)) {
      throw new Error('worktree: pr-checkout requires a positive pull.number and valid pull.headRef');
    }
    if (pull.baseRef && !isValidBaseSelector(pull.baseRef)) {
      throw new Error(`worktree: base ${JSON.stringify(pull.baseRef)} is not allowed`);
    }
  }
}

/**
 * Materialize one PR head as a local branch (paseo's fetchWorktreeCheckoutRefs):
 * the forge's universal `refs/pull/<N>/head` is the only ref that exists for a
 * fork's contribution, so it is fetched from origin first and upstream second.
 *
 * The head lands in a throwaway ref and its SHA is returned; the caller then
 * creates the local branch through `git worktree add -b <name> <sha>`, so git
 * itself owns branch-name validity and uniqueness (fetching straight into
 * `refs/heads/<name>` raced with the add). `--force` matches paseo: a re-run
 * refreshes a stale copy.
 */
async function fetchPrHead(mainRoot, number, headRef) {
  const candidates = [];
  for (const remote of ['origin', 'upstream']) {
    const url = await remoteUrl(mainRoot, remote);
    if (url) candidates.push({ remote, ref: `refs/pull/${number}/head` });
  }
  if (candidates.length === 0) {
    throw new Error('worktree: repository has no origin/upstream remote to fetch a pull request from');
  }
  const tempRef = `refs/dsh-better-workspaces/pr/${number}/${randomUUID()}`;
  const failures = [];
  try {
    for (const candidate of candidates) {
      // Default exit-0 contract: a missing remote ref must reach the failure
      // branch below. Accepting arbitrary non-zero exits once made a stale temp
      // ref from an earlier run look like a fresh fetch.
      const r = await runGit(['fetch', candidate.remote, `+${candidate.ref}:${tempRef}`, '--force'], {
        cwd: mainRoot,
        timeout: 120000,
      });
      if (r.ok) {
        const sha = (await runGit(['rev-parse', '--verify', '--quiet', `${tempRef}^{commit}`], { cwd: mainRoot })).stdout.trim();
        if (FULL_OID.test(sha)) return { sha, remote: candidate.remote, ref: candidate.ref };
        failures.push(`${candidate.remote} ${candidate.ref}: fetched but the ref did not resolve`);
      } else {
        failures.push(`${candidate.remote} ${candidate.ref}: ${r.stderr.trim().split('\n')[0] || `exit ${r.code}`}`);
      }
    }
    throw new Error(`worktree: unable to fetch pull request #${number} — ${failures.join(' | ')}`.slice(0, 600));
  } finally {
    await runGit(['update-ref', '-d', tempRef], { cwd: mainRoot });
  }
}

/** Resolve one base name/ref pair (exact refs verify; bare names prefer origin). */
async function resolveBase(mainRoot, rawBase) {
  // exact refs (the picker sends refs/heads/x or refs/remotes/origin/x —
  // paseo resolveBaseBranchForWorktree parity) verify and are used as-is;
  // bare names keep the origin-first fallback
  let baseName;
  let baseRef = null;
  if (typeof rawBase === 'string' && FULL_OID.test(rawBase)) {
    const verify = await runGit(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`], { cwd: mainRoot });
    if (!verify.ok) throw new Error(`worktree: base oid ${JSON.stringify(rawBase)} does not exist`);
    baseName = rawBase.slice(0, 12);
    baseRef = verify.stdout.trim();
  } else if (typeof rawBase === 'string' && rawBase.startsWith('refs/')) {
    const prefix = rawBase.startsWith('refs/heads/')
      ? 'refs/heads/'
      : rawBase.startsWith('refs/remotes/origin/')
        ? 'refs/remotes/origin/'
        : null;
    if (!prefix || !isValidBranchName(rawBase.slice(prefix.length))) {
      throw new Error(`worktree: base ref ${JSON.stringify(rawBase)} is not allowed`);
    }
    const verify = await runGit(['rev-parse', '--verify', '--quiet', `${rawBase}^{commit}`], { cwd: mainRoot });
    if (!verify.ok) throw new Error(`worktree: base ref ${JSON.stringify(rawBase)} does not exist`);
    baseRef = rawBase;
    baseName = rawBase.slice(prefix.length);
  } else {
    baseName = rawBase;
    if (!isValidBranchName(baseName)) throw new Error(`worktree: base branch ${JSON.stringify(baseName)} is not allowed`);
    if (await hasRemoteBranch(mainRoot, baseName)) baseRef = `refs/remotes/origin/${baseName}`;
    else if (await hasLocalBranch(mainRoot, baseName)) baseRef = `refs/heads/${baseName}`;
    else throw new Error(`worktree: base branch ${JSON.stringify(baseName)} does not exist`);
  }
  return { baseName, baseRef };
}

export async function createWorktree(opts) {
  const { repoRoot, base, intent = 'checkout', branchName, slug, sourceTitle, pull, metadataWriter = writeMetadata } = opts;
  if (typeof metadataWriter !== 'function') throw new Error('worktree: metadataWriter must be a function');
  if (!repoRoot) throw new Error('worktree: repoRoot is required');
  validateWorktreeSelectors({ base, branchName, intent, pull });
  const detect = await runGit(['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (!detect.ok) throw new Error(`worktree: ${repoRoot} is not a git repository`);
  const mainRoot = await mainRepoRootOf(repoRoot);
  const prMode = intent === 'pr-checkout';
  // The PR path derives its base from the pull request itself, not from the
  // caller's branch: the PR's base branch IS the diff baseline (paseo parity).
  const rawBase = prMode ? null : base || (await defaultBranchOf(mainRoot));
  if (!prMode && !rawBase) throw new Error('worktree: cannot resolve a base branch (empty repository?)');
  const resolvedBase = prMode ? { baseName: null, baseRef: null } : await resolveBase(mainRoot, rawBase);
  let baseName = resolvedBase.baseName;
  let baseRef = resolvedBase.baseRef;
  let baseSha = null;
  if (!prMode && baseRef) {
    const resolved = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: mainRoot });
    if (!resolved.ok || !FULL_OID.test(resolved.stdout.trim())) throw new Error('worktree: base did not resolve to a commit');
    baseSha = resolved.stdout.trim();
  }

  const root = await prepareManagedRoot(mainRoot);

  let finalBranch;
  let copiedFrom = null;
  let autoNameEligible = false;
  let prHeadSha = null;
  let prUpstream = null;
  let addArgs; // args AFTER `git worktree add <path>`
  const rollbackBranches = [];
  const existing = await listWorktreesRaw(mainRoot);
  const checkedOutBranches = new Set(existing.map((w) => w.branch).filter(Boolean));

  if (intent === 'branch-off') {
    // paseo semantics: placeholder branch cut from the base — seeded by the
    // caller's slug (mnemonic) when no explicit branch name was requested;
    // slugless callers get a server-side mnemonic. Explicit names are final.
    const wanted = branchName || (slug ? slugify(slug) : '') || mnemonicSlug();
    if (!isValidBranchName(wanted)) throw new Error(`worktree: branch ${JSON.stringify(wanted)} is not allowed`);
    autoNameEligible = !branchName;
    finalBranch = await uniqueLocalBranchName(mainRoot, wanted);
    rollbackBranches.push(finalBranch);
    addArgs = ['-b', finalBranch, '--no-track', baseRef];
  } else if (prMode) {
    // PR checkout (paseo's checkout-change-request): the PR's head becomes a
    // local branch, fetched from the forge's universal head ref rather than
    // from the contributor's branch name — that is the only ref that exists
    // for a fork PR. Same-repo PRs track origin/<headRef>; fork PRs get the
    // `<owner>/<headRef>` local name and NO upstream (push semantics stay
    // explicit unless the user asks for a remote).
    const anchor = await anchorLocalBranchName(mainRoot, pull.forkOwner, pull.headRef);
    const pulled = await fetchPrHead(mainRoot, pull.number, anchor);
    finalBranch = anchor;
    rollbackBranches.push(finalBranch);
    addArgs = ['-b', finalBranch, '--no-track', pulled.sha];
    prHeadSha = pulled.sha;
    prUpstream = pulled.remote === 'origin' && !pull.forkOwner ? pull.headRef : null;
    if (pull.baseRef) {
      const resolved = await resolveBaseTolerant(mainRoot, pull.baseRef);
      if (resolved.baseRef) {
        baseName = resolved.baseName;
        baseRef = resolved.baseRef;
        const resolvedOid = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: mainRoot });
        baseSha = resolvedOid.ok && FULL_OID.test(resolvedOid.stdout.trim()) ? resolvedOid.stdout.trim() : null;
      }
    }
  } else {
    // checkout intent
    const target = branchName || baseName;
    if (!isValidBranchName(target)) throw new Error(`worktree: branch ${JSON.stringify(target)} is not allowed`);
    if (await hasLocalBranch(mainRoot, target)) {
      if (checkedOutBranches.has(target)) {
        // branch already checked out elsewhere → unique copy branch (paseo behavior)
        copiedFrom = target;
        finalBranch = await uniqueLocalBranchName(mainRoot, target);
        rollbackBranches.push(finalBranch);
        addArgs = ['-b', finalBranch, '--no-track', `refs/heads/${target}`];
      } else {
        finalBranch = target;
        addArgs = [target];
      }
    } else if (await hasRemoteBranch(mainRoot, target)) {
      // Create the local tracking branch atomically as part of worktree add.
      // A check-then-fetch into refs/heads could race another branch creator
      // and make rollback delete a ref this call never owned.
      finalBranch = target;
      rollbackBranches.push(finalBranch);
      addArgs = ['-b', finalBranch, '--track', `refs/remotes/origin/${target}`];
    } else {
      throw new Error(`worktree: branch ${JSON.stringify(target)} exists neither locally nor on origin`);
    }
  }

  const finalPath = await uniquePath(join(root, slugify(slug || finalBranch)));
  let added = false;
  let tracked = null;
  const ownedBranchOids = new Map();
  try {
    await requireDirectDirectory(root, 'repository managed root');
    // git worktree add <path> [-b <new> --no-track <base> | <branch>]
    const result = await runGit(['worktree', 'add', finalPath, ...addArgs], {
      cwd: mainRoot,
      timeout: 120000,
    });
    if (!result.ok) {
      throw new Error(`worktree: git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    added = true;
    for (const branch of new Set(rollbackBranches)) {
      const oid = await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: mainRoot });
      if (!oid.ok || !FULL_OID.test(oid.stdout.trim())) throw new Error(`worktree: cannot record ownership of branch ${branch}`);
      ownedBranchOids.set(branch, oid.stdout.trim());
    }

  // Same-repo PRs track the head branch's remote-tracking ref (paseo's
  // trackOriginHead); a fork PR keeps an empty upstream on purpose — the
  // contributor's branch is not ours to push to, and a tracking ref named
  // origin/<headRef> would point at the BASE repository's branch of that name
  // rather than at the fork's commit. A same-repo branch tracks only an
  // already-fetched origin ref that resolves to the exact PR head. Never
  // manufacture or overwrite a remote-tracking ref from client metadata.
  if (prUpstream && prHeadSha) {
    const trackRef = `refs/remotes/origin/${prUpstream}`;
    const existingTrack = await runGit(['rev-parse', '--verify', '--quiet', `${trackRef}^{commit}`], { cwd: mainRoot });
    if (existingTrack.ok && existingTrack.stdout.trim() === prHeadSha) {
      const track = await runGit(['branch', `--set-upstream-to=origin/${prUpstream}`, finalBranch], {
        cwd: finalPath,
      });
      if (track.ok) tracked = `origin/${prUpstream}`;
    }
  }

  const metadata = {
    version: METADATA_VERSION,
    baseRef: baseSha,
    baseRefName: baseName,
    intent,
    branch: finalBranch,
    copiedFrom,
    slug: basename(finalPath),
    mainRepoRoot: mainRoot,
    createdAt: Date.now(),
    // PR provenance: which PR this worktree materialized, and the exact head
    // it was cut at. Nothing in the plugin reads these back yet — the badge's
    // upstream state comes from git's own configuration (see the
    // `--set-upstream-to` above), not from here — so they are recorded for
    // humans and for any later feature that must re-derive the PR.
    ...(prMode
      ? {
          pullNumber: pull.number,
          pullHeadRef: pull.headRef,
          ...(pull.forkOwner ? { pullForkOwner: pull.forkOwner } : {}),
          ...(prHeadSha ? { prHeadSha } : {}),
          ...(tracked ? { upstream: tracked } : {}),
        }
      : {}),
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
    await requireDirectDirectory(root, 'repository managed root');
    const createdReal = await realpath(finalPath);
    if (!pathIsInside(root, createdReal)) throw new Error('worktree: created path escaped the managed root');
    await metadataWriter(finalPath, metadata);
  } catch (error) {
    const rollbackFailures = [];
    if (added) {
      const removed = await runGit(['worktree', 'remove', '--force', finalPath], { cwd: mainRoot, timeout: 120000 });
      if (!removed.ok) rollbackFailures.push(`remove: ${removed.stderr.trim() || removed.stdout.trim()}`);
    }
    for (const [branch, ownedOid] of [...ownedBranchOids.entries()].reverse()) {
      const dropped = await runGit(['update-ref', '-d', `refs/heads/${branch}`, ownedOid], { cwd: mainRoot });
      if (!dropped.ok) rollbackFailures.push(`branch ${branch}: changed since creation or could not delete (${dropped.stderr.trim() || dropped.stdout.trim()})`);
    }
    const detail = rollbackFailures.length ? `; rollback failed: ${rollbackFailures.join(' | ')}` : '';
    throw new Error(`${String(error?.message ?? error)}${detail}`);
  }
  return {
    path: finalPath,
    branch: finalBranch,
    baseRef: baseSha,
    baseRefName: baseName,
    copiedFrom,
    ...(prMode ? { pullNumber: pull.number, prHeadSha, upstream: tracked } : {}),
  };
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
    const managed = await validateManagedWorktree(entry.path, { expectedMainRoot: mainRoot });
    const metadata = managed.ok ? managed.metadata : null;
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
      managed: managed.ok,
      baseRefName: metadata?.baseRefName ?? null,
      createdAt,
      current: realCurrent !== null && real === realCurrent,
      isMain: real === realMain,
    });
  }
  return { mainRepoRoot: mainRoot, root, items };
}

/**
 * Archive one strongly verified managed worktree. Ownership requires canonical
 * namespace placement, valid metadata/source identity and an exact Git list
 * row. Non-force refuses dirty/unpushed state and lets Git enforce the final
 * race guard; recursive deletion is reserved for explicit force.
 */
export async function archiveWorktree(path, opts = {}) {
  const { force = false } = opts;
  const managed = await validateManagedWorktree(path);
  if (!managed.ok) {
    return { ok: false, reason: 'not-managed', message: `仅托管 worktree 可归档（${managed.reason}）` };
  }
  path = managed.cwd;
  const metadata = managed.metadata;
  if (!force) {
    const status = await runGit(['status', '--porcelain'], { cwd: path });
    if (!status.ok) {
      return { ok: false, reason: 'inspect-failed', stage: 'status', message: status.stderr.trim().slice(0, 600) };
    }
    const dirty = status.stdout.trim() !== '';
    const branch = metadata.branch;
    let unpushed = 0;
    if (branch) {
      const remoteRef = (await hasRemoteBranch(path, branch)) ? `refs/remotes/origin/${branch}` : null;
      if (remoteRef) {
        const ahead = await runGit(['rev-list', '--count', `${remoteRef}..HEAD`], { cwd: path });
        if (!ahead.ok) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: ahead.stderr.trim().slice(0, 600) };
        }
        unpushed = Number(ahead.stdout.trim());
        if (!Number.isSafeInteger(unpushed)) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'git rev-list returned an invalid count' };
        }
      } else {
        // No same-name remote branch. Counting EVERY commit (old rule) made
        // clean fresh worktrees unarchivable in repos whose origin lacks the
        // branch: count commits no origin ref carries instead; without any
        // origin fall back to the recorded base ref (unique-commit count).
        const hasOrigin = (await originUrl(path)) !== null;
        if (!hasOrigin && !metadata.baseRef) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'recorded base commit unavailable' };
        }
        const range = hasOrigin ? ['HEAD', '--not', '--remotes=origin'] : [`${metadata.baseRef}..HEAD`];
        const count = await runGit(['rev-list', '--count', ...range], { cwd: path });
        if (!count.ok) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: count.stderr.trim().slice(0, 600) };
        }
        unpushed = Number(count.stdout.trim());
        if (!Number.isSafeInteger(unpushed)) {
          return { ok: false, reason: 'inspect-failed', stage: 'unpushed', message: 'git rev-list returned an invalid count' };
        }
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
  const mainRoot = managed.mainRepoRoot;
  // Non-force removal is the final race guard: Git refuses if a file appears
  // after the safety probes above. Only an explicit caller force may bypass it.
  const removeArgs = ['worktree', 'remove', path];
  if (force) removeArgs.push('--force');
  const removed = await runGit(removeArgs, { cwd: mainRoot, timeout: 60000 });
  if (!removed.ok) {
    return {
      ok: false,
      reason: 'teardown-failed',
      stage: 'worktree-remove',
      path,
      message: removed.stderr.trim().slice(0, 600),
    };
  }
  if (!force) {
    try {
      await stat(path);
      return {
        ok: false,
        partial: true,
        reason: 'teardown-failed',
        stage: 'path-remains',
        path,
        message: 'worktree was unregistered but its path still exists; refusing recursive deletion without force',
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return {
          ok: false,
          partial: true,
          reason: 'teardown-failed',
          stage: 'path-verify',
          path,
          message: String(error.message || error).slice(0, 600),
        };
      }
    }
  } else {
    let rmError = null;
    for (const delay of [0, 100, 300, 700, 1500]) {
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      try {
        await rm(path, { recursive: true, force: true });
        rmError = null;
        break;
      } catch (error) {
        rmError = error;
      }
    }
    if (rmError) {
      return {
        ok: false,
        partial: true,
        reason: 'teardown-failed',
        stage: 'filesystem-remove',
        path,
        message: String(rmError.message || rmError).slice(0, 600),
      };
    }
  }
  const pruned = await runGit(['worktree', 'prune'], { cwd: mainRoot });
  if (!pruned.ok) {
    return {
      ok: false,
      partial: true,
      reason: 'teardown-failed',
      stage: 'worktree-prune',
      path,
      message: pruned.stderr.trim().slice(0, 600),
    };
  }
  return { ok: true, path, branch: metadata.branch };
}
