/**
 * diff.js — paseo's two-mode diff: `uncommitted` (working tree incl. untracked
 * vs HEAD) and `base` (merge-base(recorded base, HEAD) vs HEAD), parsed into
 * structured files/hunks with per-file 1 MiB and total 2 MiB caps. No
 * staged/unstaged split (paseo doesn't have one either).
 */
import { EMPTY_TREE, runGit, headState, tryMergeBase, resolveBestComparisonBaseRef, resolveDefaultBranch } from './git.js';
import { readMetadata } from './worktree.js';

const FILE_MAX_BYTES = 1024 * 1024; // 1 MiB per file
const TOTAL_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB whole diff
const UNTRACKED_PATCH_LIMIT = 200;
const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

function validBranchName(value) {
  if (typeof value !== 'string' || value === '' || value === '@' || value.length > 255) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false;
  if (value.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'))) return false;
  // eslint-disable-next-line no-control-regex -- mirrors git-check-ref-format exclusions
  return !/[\s~^:?*[\]\\\u0000-\u001f\u007f]/.test(value);
}

function validBaseSelector(value) {
  if (FULL_OID.test(value)) return true;
  for (const prefix of ['refs/heads/', 'refs/remotes/origin/', 'origin/']) {
    if (value.startsWith(prefix)) return validBranchName(value.slice(prefix.length));
  }
  return validBranchName(value);
}

function literalPathspec(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || value.startsWith('/')) {
    throw new Error('invalid diff path');
  }
  const segments = value.split('/');
  if (segments.includes('..')) throw new Error('invalid diff path');
  return `:(literal)${value}`;
}

/**
 * Resolve the comparison refs for one diff request (paseo's
 * resolveCheckoutDiffRefs).
 * @returns {Promise<{baseRef:string, targetRef?:string, includeUntracked:boolean, label:string}>}
 */
export async function resolveDiffRefs(cwd, opts = {}) {
  const { mode = 'uncommitted', baseRef: requestedBase } = opts;
  if (requestedBase !== undefined && !validBaseSelector(requestedBase)) throw new Error('invalid base revision');
  if (mode === 'uncommitted') {
    const head = await headState(cwd);
    if (!head.ok) throw new Error(head.error || 'cannot resolve HEAD');
    return {
      baseRef: head.unborn ? EMPTY_TREE : 'HEAD',
      includeUntracked: true,
      label: 'uncommitted',
    };
  }
  if (mode === 'task') {
    // paseo worktree-diff semantics: everything this worktree accumulated since
    // its base — committed AND uncommitted — i.e. the session's history
    const metadata = await readMetadata(cwd).catch(() => null);
    const base = metadata?.baseRef || null;
    if (!base || !FULL_OID.test(base)) throw new Error('task-base-missing');
    const verify = await runGit(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd });
    const baseOid = verify.stdout.trim();
    if (!verify.ok || !FULL_OID.test(baseOid)) throw new Error('task-base-missing');
    const mergeBase = (await tryMergeBase(cwd, baseOid, 'HEAD')) ?? baseOid;
    const displayBase = validBaseSelector(metadata?.baseRefName || '') ? metadata.baseRefName : base.slice(0, 8);
    return { baseRef: mergeBase, includeUntracked: true, label: `task:${displayBase}` };
  }
  const metadata = await readMetadata(cwd).catch(() => null);
  const storedBase = metadata?.baseRefName || null;
  if (storedBase && !validBaseSelector(storedBase)) throw new Error('invalid stored base revision');
  const fallbackBase = await resolveDefaultBranch(cwd);
  const baseName = requestedBase || storedBase || fallbackBase;
  if (!baseName) return { baseRef: EMPTY_TREE, targetRef: 'HEAD', includeUntracked: false, label: 'base:?' };
  if (!validBaseSelector(baseName)) throw new Error('invalid base revision');
  const resolvedBest = await resolveBestComparisonBaseRef(cwd, baseName);
  const best = resolvedBest || (FULL_OID.test(baseName) ? baseName : null);
  if (!best) throw new Error('invalid base revision');
  const verified = await runGit(['rev-parse', '--verify', '--quiet', `${best}^{commit}`], { cwd });
  if (!verified.ok || !FULL_OID.test(verified.stdout.trim())) throw new Error('invalid base revision');
  const oid = verified.stdout.trim();
  const mergeBase = (await tryMergeBase(cwd, oid, 'HEAD')) ?? oid;
  return { baseRef: mergeBase, targetRef: 'HEAD', includeUntracked: false, label: `base:${baseName}` };
}

/** Parse `git diff --name-status -z -M` without display quoting. */
function parseNameStatus(text) {
  const records = text.split('\0');
  const files = [];
  for (let index = 0; index < records.length;) {
    const code = records[index++];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = records[index++] ?? '';
      const path = records[index++] ?? '';
      files.push({ status: code.startsWith('R') ? 'renamed' : 'copied', oldPath, path, score: code.slice(1) });
    } else {
      const path = records[index++] ?? '';
      const status =
        code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'T' ? 'type-changed' : 'modified';
      files.push({ status, path, oldPath: null });
    }
  }
  return files;
}

/** Parse `git diff --numstat -z -M` into lossless path statistics. */
function parseNumstat(text) {
  const records = text.split('\0');
  const map = new Map();
  for (let index = 0; index < records.length;) {
    const header = records[index++];
    if (!header) continue;
    const [a, d, ...pathParts] = header.split('\t');
    let path = pathParts.join('\t');
    if (path === '') {
      index += 1; // old path for a rename/copy
      path = records[index++] ?? '';
    }
    map.set(path, {
      additions: a === '-' ? null : Number(a) || 0,
      deletions: d === '-' ? null : Number(d) || 0,
      binary: a === '-' || d === '-',
    });
  }
  return map;
}

/** Decode Git's C-quoted path, including octal UTF-8 bytes and \a/\v. */
function decodePatchPath(raw) {
  const value = String(raw || '');
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes = [];
  const escapes = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const inner = value.slice(1, -1);
  for (let index = 0; index < inner.length; index += 1) {
    const codePoint = inner.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    if (char !== '\\') {
      bytes.push(...Buffer.from(char));
      if (codePoint > 0xffff) index += 1;
      continue;
    }
    const next = inner[++index];
    if (next === undefined) {
      bytes.push(92);
      break;
    }
    if (Object.hasOwn(escapes, next)) {
      bytes.push(escapes[next]);
      continue;
    }
    if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(inner[index + 1] || '')) octal += inner[++index];
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    bytes.push(...Buffer.from(next));
  }
  return Buffer.from(bytes).toString('utf8');
}

function markerPath(line, prefix, side) {
  let raw = line.slice(prefix.length);
  if (raw.endsWith('\t')) raw = raw.slice(0, -1);
  if (raw === '/dev/null') return null;
  return decodePatchPath(raw).replace(new RegExp(`^${side}/`), '');
}

/**
 * Parse one unified patch into per-file hunks.
 * Returns Map<bPath, {isNew, isDeleted, isBinary, oldPath, hunks:[{oldStart,oldCount,newStart,newCount,lines:[{type,content}]}], bytes}>
 */
export function parsePatch(patchText) {
  const files = new Map();
  const chunks = patchText.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const header = lines[0] ?? '';
    // header: `a/path b/path`; control characters/quotes use two JSON-like
    // quoted tokens because patch commands force core.quotePath=false.
    let oldPath = null;
    let newPath;
    const quoted = /^("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/.exec(header);
    if (quoted) {
      oldPath = decodePatchPath(quoted[1]).replace(/^a\//, '');
      newPath = decodePatchPath(quoted[2]).replace(/^b\//, '');
    } else {
      const hm = /^a\/(.*?) b\/(.*)$/.exec(header);
      if (hm) {
        oldPath = hm[1];
        newPath = hm[2];
      } else {
        newPath = header.replace(/^"?\w?\//, '').split(' b/')[0] || header;
      }
    }
    const entry = {
      isNew: false,
      isDeleted: false,
      isBinary: false,
      oldPath: null,
      hunks: [],
      bytes: chunk.length,
    };
    let i = 1;
    let currentHunk = null;
    for (; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith('new file mode')) entry.isNew = true;
      else if (line.startsWith('deleted file mode')) entry.isDeleted = true;
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) entry.isBinary = true;
      else if (line.startsWith('rename from ')) entry.oldPath = decodePatchPath(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) newPath = decodePatchPath(line.slice('rename to '.length));
      else if (line.startsWith('copy from ')) entry.oldPath = decodePatchPath(line.slice('copy from '.length));
      else if (line.startsWith('--- ')) {
        const markedOld = markerPath(line, '--- ', 'a');
        if (markedOld !== null) oldPath = markedOld;
      } else if (line.startsWith('+++ ')) {
        const markedNew = markerPath(line, '+++ ', 'b');
        if (markedNew !== null) newPath = markedNew;
      } else if (line.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        currentHunk = {
          oldStart: m ? Number(m[1]) : 0,
          oldCount: m && m[2] !== undefined ? Number(m[2]) : 1,
          newStart: m ? Number(m[3]) : 0,
          newCount: m && m[4] !== undefined ? Number(m[4]) : 1,
          header: line.replace(/^@@[^@]*@@/, '').trim(),
          lines: [],
        };
        entry.hunks.push(currentHunk);
      } else if (currentHunk) {
        if (line.startsWith('+')) currentHunk.lines.push({ type: 'add', content: line.slice(1) });
        else if (line.startsWith('-')) currentHunk.lines.push({ type: 'del', content: line.slice(1) });
        else if (line.startsWith('\\')) currentHunk.lines.push({ type: 'meta', content: line });
        else currentHunk.lines.push({ type: 'ctx', content: line.startsWith(' ') ? line.slice(1) : line });
      }
    }
    const key = entry.isDeleted ? oldPath : newPath || oldPath;
    if (key) files.set(key, entry);
  }
  return files;
}

/**
 * Compute the structured diff for a cwd.
 * @param {string} cwd
 * @param {{mode?:'uncommitted'|'base', baseRef?:string, ignoreWhitespace?:boolean, path?:string}} opts
 */
export async function computeDiff(cwd, opts = {}) {
  const { mode = 'uncommitted', ignoreWhitespace = false, path: onlyPath } = opts;
  const refs = await resolveDiffRefs(cwd, opts);
  const w = ignoreWhitespace ? ['-w'] : [];
  const range = refs.targetRef ? [refs.baseRef, refs.targetRef] : [refs.baseRef];

  const nameStatusArgs = ['diff', ...w, '--name-status', '-z', '-M', ...range];
  const numstatArgs = ['diff', ...w, '--numstat', '-z', '-M', ...range];
  const patchArgs = ['-c', 'core.quotePath=false', 'diff', ...w, '-M', '--no-color', ...range];
  if (onlyPath) {
    const pathspec = literalPathspec(onlyPath);
    nameStatusArgs.push('--', pathspec);
    numstatArgs.push('--', pathspec);
    patchArgs.push('--', pathspec);
  }
  const [ns, num, patch] = await Promise.all([
    runGit(nameStatusArgs, { cwd, timeout: 60000 }),
    runGit(numstatArgs, { cwd, timeout: 60000 }),
    runGit(patchArgs, { cwd, timeout: 60000 }),
  ]);
  const failed = [ns, num, patch].find((result) => !result.ok);
  if (failed) throw new Error((failed.stderr || 'git diff failed').trim().slice(0, 600));

  const fileList = parseNameStatus(ns.stdout);
  const stats = parseNumstat(num.stdout);
  const parsed = parsePatch(patch.stdout);

  let totalBytes = patch.stdout.length;
  let tooLarge = false;

  const files = [];
  for (const f of fileList) {
    const p = parsed.get(f.path);
    const st = stats.get(f.path);
    const bytes = p?.bytes ?? 0;
    let status = f.status;
    if (p?.isBinary || st?.binary) status = 'binary';
    else if (bytes > FILE_MAX_BYTES) status = 'too_large';
    if (status !== 'binary' && status !== 'too_large' && totalBytes > TOTAL_MAX_BYTES) {
      tooLarge = true;
      status = 'too_large';
    }
    files.push({
      path: f.path,
      oldPath: f.oldPath ?? p?.oldPath ?? null,
      status,
      additions: st?.additions ?? countLines(p, 'add'),
      deletions: st?.deletions ?? countLines(p, 'del'),
      hunks: status === 'binary' || status === 'too_large' ? [] : (p?.hunks ?? []),
    });
  }

  // untracked files (uncommitted mode): diff each against /dev/null
  if (refs.includeUntracked && !onlyPath) {
    const status = await runGit(['ls-files', '-z', '--others', '--exclude-standard'], { cwd, timeout: 30000 });
    if (!status.ok) throw new Error((status.stderr || 'git ls-files failed').trim().slice(0, 600));
    const untracked = status.stdout.split('\0').filter(Boolean).slice(0, UNTRACKED_PATCH_LIMIT);
    for (const rel of untracked) {
      const r = await runGit(['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color', '--', '/dev/null', rel], {
        cwd,
        acceptedExitCodes: [0, 1],
        timeout: 30000,
      });
      if (!r.ok) throw new Error((r.stderr || 'git diff --no-index failed').trim().slice(0, 600));
      const parsedOne = parsePatch(r.stdout);
      const entry = parsedOne.get(rel) ?? parsedOne.values().next().value;
      const bytes = entry?.bytes ?? 0;
      let fileStatus = 'added';
      let hunks = entry?.hunks ?? [];
      if (r.stdout.includes('Binary files')) fileStatus = 'binary';
      else if (bytes > FILE_MAX_BYTES) fileStatus = 'too_large';
      if (fileStatus === 'added' && totalBytes + bytes > TOTAL_MAX_BYTES) {
        tooLarge = true;
        fileStatus = 'too_large';
        hunks = [];
      }
      totalBytes += bytes;
      files.push({
        path: rel,
        oldPath: null,
        status: fileStatus,
        additions: countLines(entry, 'add'),
        deletions: 0,
        hunks,
        untracked: true,
      });
    }
  }

  files.sort(compareDiffPaths);
  return { mode, refs: { baseRef: refs.baseRef, targetRef: refs.targetRef ?? null, label: refs.label }, files, tooLarge };
}

function countLines(parsedEntry, type) {
  if (!parsedEntry) return 0;
  let n = 0;
  for (const hunk of parsedEntry.hunks) for (const line of hunk.lines) if (line.type === type) n += 1;
  return n;
}

/** Paseo's diff-order: directories before files within a level, then by name. */
export function compareDiffPaths(a, b) {
  const ap = a.path.split('/');
  const bp = b.path.split('/');
  const depth = Math.min(ap.length, bp.length);
  for (let i = 0; i < depth; i += 1) {
    const aLast = i === ap.length - 1;
    const bLast = i === bp.length - 1;
    if (aLast !== bLast) return aLast ? 1 : -1; // deeper (dir) first
    if (ap[i] !== bp[i]) return ap[i].localeCompare(bp[i]);
  }
  return ap.length - bp.length;
}

/**
 * Per-commit file diff (merge commits vs first parent — paseo).
 */
export async function commitDiff(cwd, sha, opts = {}) {
  const { ignoreWhitespace = false, path: onlyPath } = opts;
  if (!FULL_OID.test(sha)) throw new Error('invalid commit oid');
  const parents = await runGit(['rev-list', '--parents', '-1', sha], { cwd });
  if (!parents.ok) throw new Error('commit oid not found');
  const parts = (parents.stdout.trim().split(/\s+/) || []).filter(Boolean);
  if (parts.length === 0) throw new Error('commit oid not found');
  const isMerge = parts.length > 2;
  const isRoot = parts.length === 1;
  const w = ignoreWhitespace ? ['-w'] : [];
  let range;
  if (isRoot) range = [EMPTY_TREE, sha];
  else if (isMerge) range = [`${sha}^1`, sha];
  else range = [`${sha}^`, sha];
  const suffix = onlyPath ? ['--', literalPathspec(onlyPath)] : [];
  const [ns, num, patch] = await Promise.all([
    runGit(['diff', ...w, '--name-status', '-z', '-M', ...range, ...suffix], { cwd, timeout: 60000 }),
    runGit(['diff', ...w, '--numstat', '-z', '-M', ...range, ...suffix], { cwd, timeout: 60000 }),
    runGit(['-c', 'core.quotePath=false', 'diff', ...w, '-M', '--no-color', ...range, ...suffix], { cwd, timeout: 60000 }),
  ]);
  const failed = [ns, num, patch].find((result) => !result.ok);
  if (failed) throw new Error((failed.stderr || 'git diff failed').trim().slice(0, 600));
  const fileList = parseNameStatus(ns.stdout);
  const stats = parseNumstat(num.stdout);
  const parsed = parsePatch(patch.stdout);
  const files = fileList.map((f) => {
    const p = parsed.get(f.path);
    const st = stats.get(f.path);
    let status = p?.isBinary || st?.binary ? 'binary' : f.status;
    if ((p?.bytes ?? 0) > FILE_MAX_BYTES) status = 'too_large';
    return {
      path: f.path,
      oldPath: f.oldPath ?? null,
      status,
      additions: st?.additions ?? countLines(p, 'add'),
      deletions: st?.deletions ?? countLines(p, 'del'),
      hunks: status === 'binary' || status === 'too_large' ? [] : (p?.hunks ?? []),
    };
  });
  files.sort(compareDiffPaths);
  return { sha, isMerge, isRoot, files };
}
