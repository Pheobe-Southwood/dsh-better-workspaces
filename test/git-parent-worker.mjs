import { runGit } from '../lib/git.js';

const [cwd, bin] = process.argv.slice(2);
const result = await runGit(['status', '--porcelain'], {
  cwd,
  parentGuard: true,
  timeout: 30000,
  env: { PATH: `${bin}:${process.env.PATH}` },
});
if (!result.ok) process.exitCode = 1;
