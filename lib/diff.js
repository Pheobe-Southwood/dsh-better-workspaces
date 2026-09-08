/**
 * diff.js — paseo's two-mode diff: `uncommitted` (working tree incl. untracked
 * vs HEAD) and `base` (merge-base(recorded base, HEAD) vs HEAD), parsed into
 * structured files/hunks with per-file 1 MiB and total 2 MiB caps. No
 * staged/unstaged split (paseo doesn't have one either).
 */
import { EMPTY_TREE, runGit, tryMergeBase, resolveBestComparisonBaseRef, resolveDefaultBranch, hasRemoteBranch } from './git.js';
import { readMetadata } from './worktree.js';

const FILE_MAX_BYTES = 1024 * 1024; // 1 MiB per file
const TOTAL_MAX_BYTES = 2 * 1024 * 1024; // 2 MiB whole diff
const UNTRACKED_PATCH_LIMIT = 200;

/**
 * Resolve the comparison refs for one diff request (paseo's
 * resolveCheckoutDiffRefs).
 * @returns {Promise<{baseRef:string, targetRef?:string, includeUntracked:boolean, label:string}>}
 */
export async function resolveDiffRefs(cwd, opts = {}) {
  const { mode = 'uncommitted', baseRef: requestedBase } = opts;
  if (mode === 'uncommitted') {
    const head = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
    return {
      baseRef: head.ok ? 'HEAD' : EMPTY_TREE,
      includeUntracked: true,
      label: 'uncommitted',
    };
  }
  if (mode === 'task') {
    // paseo worktree-diff semantics: everything this worktree accumulated since
    // its base — committed AND uncommitted — i.e. the session's history
    const metadata = await readMetadata(cwd).catch(() => null);
    const base = metadata?.baseRef || null;
    if (!base) throw new Error('task-base-missing');
    const verify = await runGit(['rev-parse', '--verify', '--quiet', base], { cwd });
    if (!verify.ok) throw new Error('task-base-missing');
    const mergeBase = (await tryMergeBase(cwd, base, 'HEAD')) ?? base;
    return { baseRef: mergeBase, includeUntracked: true, label: `task:${metadata?.baseRefName || base.slice(0, 8)}` };
  }
  const metadata = await readMetadata(cwd).catch(() => null);
  const storedBase = metadata?.baseRefName || null;
  const fallbackBase = await resolveDefaultBranch(cwd);
  const baseName = requestedBase || storedBase || fallbackBase;
  if (!baseName) return { baseRef: EMPTY_TREE, targetRef: 'HEAD', includeUntracked: false, label: 'base:?' };
  const best = (await resolveBestComparisonBaseRef(cwd, baseName)) ?? baseName;
  const mergeBase = (await tryMergeBase(cwd, best, 'HEAD')) ?? best;
  return { baseRef: mergeBase, targetRef: 'HEAD', includeUntracked: false, label: `base:${baseName}` };
}

/** Parse `git diff --name-status -M` output. */
function parseNameStatus(text) {
  const files = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R') || code.startsWith('C')) {
      files.push({ status: code.startsWith('R') ? 'renamed' : 'copied', oldPath: parts[1], path: parts[2], score: code.slice(1) });
    } else {
      const status =
        code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'T' ? 'type-changed' : 'modified';
      files.push({ status, path: parts[1], oldPath: null });
    }
  }
  return files;
}

/** Parse `git diff --numstat -M` output into Map<path, {additions, deletions, binary}>. */
function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    let path = rest.join('\t');
    // renames render as `old => new` or with -z… plain form: "path" or "old => new" inside braces; use last segment
    const rename = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
    if (rename) path = rename[1] + rename[3] + rename[4];
    else path = path.replace(/^.* => /, '');
    map.set(path, {
      additions: a === '-' ? null : Number(a) || 0,
      deletions: d === '-' ? null : Number(d) || 0,
      binary: a === '-' || d === '-',
    });
  }
  return map;
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
    // header: `a/path b/path` (paths may contain spaces; use the a/ b/ markers)
    let oldPath = null;
    let newPath = null;
    const hm = /^a\/(.*?) b\/(.*)$/.exec(header);
    if (hm) {
      oldPath = hm[1];
      newPath = hm[2];
    } else {
      newPath = header.replace(/^"?\w?\//, '').split(' b/')[0] || header;
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
      else if (line.startsWith('rename from ')) entry.oldPath = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) newPath = line.slice('rename to '.length);
      else if (line.startsWith('copy from ')) entry.oldPath = line.slice('copy from '.length);
      else if (line.startsWith('--- ')) {
        /* header noise */
      } else if (line.startsWith('+++ ')) {
        /* header noise */
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
    if (newPath) files.set(newPath, entry);
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

  const nameStatusArgs = ['diff', ...w, '--name-status', '-M', ...range];
  const numstatArgs = ['diff', ...w, '--numstat', '-M', ...range];
  const patchArgs = ['diff', ...w, '-M', '--no-color', ...range];
  if (onlyPath) {
    nameStatusArgs.push('--', onlyPath);
    numstatArgs.push('--', onlyPath);
    patchArgs.push('--', onlyPath);
  }
  const [ns, num, patch] = await Promise.all([
    runGit(nameStatusArgs, { cwd, allowFail: true, timeout: 60000 }),
    runGit(numstatArgs, { cwd, allowFail: true, timeout: 60000 }),
    runGit(patchArgs, { cwd, allowFail: true, timeout: 60000 }),
  ]);

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
    const status = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd, timeout: 30000 });
    const untracked = status.stdout.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, UNTRACKED_PATCH_LIMIT);
    for (const rel of untracked) {
      const r = await runGit(['diff', '--no-index', '--no-color', '/dev/null', rel], {
        cwd,
        allowFail: true,
        timeout: 30000,
      });
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
  const parents = await runGit(['rev-list', '--parents', '-1', sha], { cwd, allowFail: true });
  const parts = (parents.stdout.trim().split(/\s+/) || []).filter(Boolean);
  const isMerge = parts.length > 2;
  const isRoot = parts.length === 1;
  const w = ignoreWhitespace ? ['-w'] : [];
  let range;
  if (isRoot) range = [EMPTY_TREE, sha];
  else if (isMerge) range = [`${sha}^1`, sha];
  else range = [`${sha}^`, sha];
  const suffix = onlyPath ? ['--', onlyPath] : [];
  const [ns, num, patch] = await Promise.all([
    runGit(['diff', ...w, '--name-status', '-M', ...range, ...suffix], { cwd, allowFail: true, timeout: 60000 }),
    runGit(['diff', ...w, '--numstat', '-M', ...range, ...suffix], { cwd, allowFail: true, timeout: 60000 }),
    runGit(['diff', ...w, '-M', '--no-color', ...range, ...suffix], { cwd, allowFail: true, timeout: 60000 }),
  ]);
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
