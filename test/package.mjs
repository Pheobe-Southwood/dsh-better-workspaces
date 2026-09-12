import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(manifest.main, 'lib/index.js');
assert.equal(manifest.exports?.['.'], './lib/index.js');
assert.equal(manifest.exports?.['./client'], './lib/client.js');
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');

const npmCommand = process.env.npm_execpath ? process.execPath : 'npm';
const npmArgs = process.env.npm_execpath
  ? [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--ignore-scripts']
  : ['pack', '--dry-run', '--json', '--ignore-scripts'];
const packed = spawnSync(npmCommand, npmArgs, {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, npm_config_loglevel: 'error' },
});
assert.equal(packed.status, 0, `npm pack failed: ${packed.stderr || packed.stdout}`);
let report;
try {
  report = JSON.parse(packed.stdout);
} catch (error) {
  throw new Error(`npm pack did not return JSON: ${packed.stdout.slice(0, 500)}`, { cause: error });
}
assert.equal(report.length, 1, 'npm pack reports exactly one package');
const files = new Set(report[0].files.map((entry) => entry.path));
for (const required of [
  'package.json',
  'README.md',
  'LICENSE',
  'NOTICE',
  'LICENSES/paseo-Apache-2.0.txt',
  'LICENSES/dsh-git-worktree-MIT.txt',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
]) {
  assert.ok(files.has(required), `published package is missing ${required}`);
}
for (const path of files) {
  assert.ok(!path.startsWith('test/'), `test fixture leaked into package: ${path}`);
  assert.ok(!path.startsWith('.github/'), `CI file leaked into package: ${path}`);
  assert.ok(!path.startsWith('node_modules/'), `dependency leaked into package: ${path}`);
  assert.notEqual(path, 'eslint.config.js', 'lint config leaked into package');
  assert.notEqual(path, 'package-lock.json', 'lockfile leaked into package');
  assert.ok(!path.endsWith('.tgz'), `nested tarball leaked into package: ${path}`);
}
assert.ok(report[0].size > 0 && report[0].unpackedSize > report[0].size, 'pack report has plausible sizes');
console.log(`PACKAGE: ALL PASS (${files.size} files, ${report[0].size} bytes)`);
