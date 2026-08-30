import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SerializedPhaseQueue } from '../src/phase-queue.ts';
import type { DayNightPhase } from '../src/schedule.ts';

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

test('serializes phase changes and coalesces adjacent duplicates', async () => {
  const runs: DayNightPhase[] = [];
  const gates = [deferred(), deferred()];
  const queue = new SerializedPhaseQueue(async phase => {
    runs.push(phase);
    await gates[runs.length - 1].promise;
  });

  const firstDay = queue.request('day');
  const duplicateDay = queue.request('day');
  const night = queue.request('night');
  const duplicateNight = queue.request('night');

  assert.equal(firstDay, duplicateDay);
  assert.equal(night, duplicateNight);
  assert.deepEqual(runs, ['day']);

  gates[0].resolve();
  await firstDay;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs, ['day', 'night']);

  gates[1].resolve();
  await night;
});

test('rejects queued work when released while an action is active', async () => {
  const active = deferred();
  const queue = new SerializedPhaseQueue(async () => active.promise);

  const day = queue.request('day');
  const night = queue.request('night');
  const releaseError = new Error('released for test');
  queue.release(releaseError);

  await assert.rejects(night, /released for test/);
  active.resolve();
  await day;
  await assert.rejects(queue.request('day'), /released/);
});
