import assert from 'node:assert/strict';
import { createMutationCoordinator } from '../lib/mutation.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

{
  const mutations = createMutationCoordinator();
  let active = 0;
  let maxActive = 0;
  const order = [];
  const run = (id) => mutations.run('git:/same', async () => {
    order.push(`start:${id}`);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    order.push(`end:${id}`);
  });
  await Promise.all([run(1), run(2), run(3)]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
  assert.equal(mutations.pending(), 0);
}

{
  const mutations = createMutationCoordinator();
  const bothEntered = deferred();
  let entered = 0;
  const release = deferred();
  const task = (key) => mutations.run(key, async () => {
    entered += 1;
    if (entered === 2) bothEntered.resolve();
    await release.promise;
  });
  const one = task('git:/one');
  const two = task('git:/two');
  await bothEntered.promise;
  assert.equal(entered, 2, 'different repository keys must run concurrently');
  release.resolve();
  await Promise.all([one, two]);
}

{
  const mutations = createMutationCoordinator();
  await assert.rejects(mutations.run('git:/throw', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await mutations.run('git:/throw', async () => 42), 42, 'throwing task must release its gate');
}

{
  const mutations = createMutationCoordinator();
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const order = [];
  const first = mutations.run('git:/abort', async () => {
    order.push('first');
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  const controller = new AbortController();
  const aborted = mutations.run('git:/abort', async () => order.push('aborted-ran'), { signal: controller.signal });
  const third = mutations.run('git:/abort', async () => order.push('third'));
  controller.abort();
  await assert.rejects(aborted, (error) => error?.code === 'ABORT_ERR');
  assert.deepEqual(order, ['first'], 'aborted waiter and its successor must not overtake the owner');
  releaseFirst.resolve();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first', 'third']);
  await Promise.resolve();
  assert.equal(mutations.pending(), 0);
}

console.log('MUTATION: ALL PASS');
