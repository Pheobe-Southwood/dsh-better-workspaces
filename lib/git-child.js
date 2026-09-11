#!/usr/bin/env node
import { spawn } from 'node:child_process';

const [executable, ...args] = process.argv.slice(2);
if (!executable) process.exit(127);

let child = null;
let parentGone = false;
let stopping = false;
const originalParent = process.ppid;

function killTree() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'linux' && child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function stopForParent() {
  parentGone = true;
  stopping = true;
  killTree();
}

// The invoking Host keeps this pipe open for the command lifetime. SIGKILL or
// process death closes it in the kernel; this guardian survives just long
// enough to kill Git's process group before exiting.
process.stdin.resume();
process.stdin.once('end', stopForParent);
process.stdin.once('error', stopForParent);
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.once(signal, () => {
    stopping = true;
    killTree();
  });
}
const parentWatch = setInterval(() => {
  if (process.ppid !== originalParent) stopForParent();
  else {
    try { process.kill(originalParent, 0); } catch { stopForParent(); }
  }
}, 25);

child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  detached: process.platform === 'linux',
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (parentGone) killTree();
child.once('error', (error) => {
  clearInterval(parentWatch);
  process.stderr.write(`${String(error?.message ?? error)}\n`);
  process.exit(127);
});
child.once('exit', (code, signal) => {
  clearInterval(parentWatch);
  if (stopping) process.exit(143);
  if (Number.isInteger(code)) process.exit(code);
  process.exit(signal ? 128 : 1);
});
