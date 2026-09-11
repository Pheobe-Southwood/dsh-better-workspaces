/**
 * Per-resource mutation serialization.
 *
 * Keys are stable capability identities (`git:<main-root>` or
 * `workspace:<root>`). Waiting can be aborted without allowing later callers
 * to overtake the still-running predecessor.
 */

export class MutationAbortedError extends Error {
  constructor(message = 'mutation wait aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

export function createMutationCoordinator() {
  const tails = new Map();
  const depths = new Map();

  async function acquire(key, { signal } = {}) {
    if (typeof key !== 'string' || key === '') throw new TypeError('mutation key required');
    if (signal?.aborted) throw new MutationAbortedError();

    const previous = tails.get(key) || Promise.resolve();
    let releaseGate;
    const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    depths.set(key, (depths.get(key) || 0) + 1);
    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      releaseGate();
      const remaining = (depths.get(key) || 1) - 1;
      if (remaining === 0) depths.delete(key);
      else depths.set(key, remaining);
    };
    tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });

    let onAbort;
    try {
      await (signal
        ? Promise.race([
            previous,
            new Promise((_, reject) => {
              onAbort = () => reject(new MutationAbortedError());
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ])
        : previous);
    } catch (error) {
      releaseSlot();
      throw error;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) {
      releaseSlot();
      throw new MutationAbortedError();
    }
    return releaseSlot;
  }

  async function run(key, task, options) {
    const release = await acquire(key, options);
    try {
      return await task();
    } finally {
      release();
    }
  }

  return {
    acquire,
    run,
    pending: () => tails.size,
    depth: (key) => depths.get(key) || 0,
  };
}

// One process-wide coordinator keeps an old Cordis run that is draining from
// overlapping a freshly applied run against the same repository.
export const hostMutationCoordinator = createMutationCoordinator();
