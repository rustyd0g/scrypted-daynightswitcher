import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PhaseQueueCancellationError,
  SerializedPhaseQueue,
  type PhaseRequestContext,
} from '../src/phase-queue.ts';
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

test('selectively cancels queued automatic work without cancelling active or manual work', async () => {
  const runs: Array<{ phase: DayNightPhase; context?: PhaseRequestContext }> = [];
  const gates = [deferred(), deferred(), deferred()];
  const queue = new SerializedPhaseQueue(async (phase, context) => {
    runs.push({ phase, context });
    await gates[runs.length - 1].promise;
  });

  const active = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 1,
    expectedPhase: 'day',
  });
  const stale = queue.request('night', {
    source: 'automatic',
    scheduleGeneration: 1,
    expectedPhase: 'night',
  });
  const staleRejection = assert.rejects(stale, PhaseQueueCancellationError);
  const manual = queue.request('night', { source: 'manual' });
  const current = queue.request('night', {
    source: 'automatic',
    scheduleGeneration: 2,
    expectedPhase: 'night',
  });

  const cancelled = queue.cancelQueued(request => (
    request.context?.source === 'automatic'
      && request.context.scheduleGeneration === 1
  ));

  assert.equal(cancelled, 1);
  await staleRejection;
  assert.deepEqual(runs, [{
    phase: 'day',
    context: {
      source: 'automatic',
      scheduleGeneration: 1,
      expectedPhase: 'day',
    },
  }]);

  gates[0].resolve();
  await active;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs.map(run => [run.phase, run.context?.source]), [
    ['day', 'automatic'],
    ['night', 'manual'],
  ]);

  gates[1].resolve();
  await manual;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(runs.map(run => run.context?.scheduleGeneration), [1, undefined, 2]);

  gates[2].resolve();
  await current;
});

test('only coalesces requests with the same phase and material context', async () => {
  const runs: Array<{ phase: DayNightPhase; context?: PhaseRequestContext }> = [];
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const queue = new SerializedPhaseQueue(async (phase, context) => {
    runs.push({ phase, context });
    await gates[runs.length - 1].promise;
  });

  const manual = queue.request('day', { source: 'manual' });
  const automatic = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 4,
    expectedPhase: 'day',
  });
  const duplicateAutomatic = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 4,
    expectedPhase: 'day',
  });
  const newerAutomatic = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 5,
    expectedPhase: 'day',
  });
  const differentExpectedPhase = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 5,
    expectedPhase: 'night',
  });

  assert.notEqual(manual, automatic);
  assert.equal(automatic, duplicateAutomatic);
  assert.notEqual(automatic, newerAutomatic);
  assert.notEqual(newerAutomatic, differentExpectedPhase);

  for (let index = 0; index < gates.length; index++) {
    gates[index].resolve();
    await [manual, automatic, newerAutomatic, differentExpectedPhase][index];
    if (index < gates.length - 1) await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepEqual(runs.map(run => [
    run.context?.source,
    run.context?.scheduleGeneration,
    run.context?.expectedPhase,
  ]), [
    ['manual', undefined, undefined],
    ['automatic', 4, 'day'],
    ['automatic', 5, 'day'],
    ['automatic', 5, 'night'],
  ]);
});

test('runs a fresh same-phase request after an older generation is aborted', async () => {
  const firstAttempt = deferred();
  const runs: number[] = [];
  const queue = new SerializedPhaseQueue(async (_phase, context) => {
    runs.push(context?.scheduleGeneration ?? -1);
    if (context?.scheduleGeneration === 0) await firstAttempt.promise;
  });

  const obsolete = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 0,
    expectedPhase: 'day',
  });
  const obsoleteRejection = assert.rejects(obsolete, /aborted old generation/);
  const current = queue.request('day', {
    source: 'automatic',
    scheduleGeneration: 1,
    expectedPhase: 'day',
  });

  assert.notEqual(obsolete, current);
  firstAttempt.reject(new Error('aborted old generation'));
  await obsoleteRejection;
  await current;
  assert.deepEqual(runs, [0, 1]);
});
