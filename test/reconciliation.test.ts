import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PhaseAutomationCoordinator,
  PhaseReconciler,
} from '../src/reconciliation.ts';

const HOUR = 60 * 60_000;

test('retries a failed scheduled phase when the reconciliation interval is due', () => {
  const reconciler = new PhaseReconciler(HOUR);

  assert.equal(reconciler.markScheduledFailure('day', 0), true);
  assert.deepEqual(reconciler.evaluate('day', HOUR - 1), {
    kind: 'waiting',
    phase: 'day',
    nextAttemptAt: HOUR,
  });
  assert.deepEqual(reconciler.evaluate('day', HOUR), {
    kind: 'retry',
    phase: 'day',
  });
  assert.equal(reconciler.markSuccess('day'), true);
  assert.deepEqual(reconciler.evaluate('day', HOUR + 1), { kind: 'none' });
});

test('waits another interval after a reconciliation attempt fails', () => {
  const reconciler = new PhaseReconciler(HOUR);
  reconciler.markScheduledFailure('night', 0);

  assert.equal(reconciler.evaluate('night', HOUR).kind, 'retry');
  assert.equal(reconciler.evaluate('night', HOUR + 1).kind, 'waiting');
  assert.equal(reconciler.markAttemptFailure('night', HOUR + 10), true);
  assert.equal(reconciler.evaluate('night', 2 * HOUR).kind, 'waiting');
  assert.equal(reconciler.evaluate('night', 2 * HOUR + 10).kind, 'retry');
});

test('cancels a pending retry when the expected phase changes', () => {
  const reconciler = new PhaseReconciler(HOUR);
  reconciler.markScheduledFailure('day', 0);

  assert.deepEqual(reconciler.evaluate('night', 1), {
    kind: 'cancelled',
    phase: 'day',
  });
  assert.deepEqual(reconciler.evaluate('night', HOUR), { kind: 'none' });
});

test('only a successful action for the pending phase clears reconciliation', () => {
  const reconciler = new PhaseReconciler(HOUR);
  reconciler.markScheduledFailure('day', 0);

  assert.equal(reconciler.markSuccess('night'), false);
  assert.equal(reconciler.evaluate('day', HOUR).kind, 'retry');
  assert.equal(reconciler.markSuccess('day'), true);
  assert.deepEqual(reconciler.evaluate('day', HOUR + 1), { kind: 'none' });
});

test('clears pending reconciliation when switching is disabled', () => {
  const reconciler = new PhaseReconciler(HOUR);
  reconciler.markScheduledFailure('night', 0);

  assert.equal(reconciler.clear(), 'night');
  assert.equal(reconciler.clear(), undefined);
  assert.deepEqual(reconciler.evaluate('night', HOUR), { kind: 'none' });
});

test('coordinates a scheduled failure with an hourly recovery attempt', () => {
  const coordinator = new PhaseAutomationCoordinator(HOUR);

  const initial = coordinator.observeExpectedPhase('day', 0);
  assert.equal(initial.phaseChanged, false);
  assert.deepEqual(initial.reconciliation, { kind: 'none' });
  assert.equal(coordinator.markScheduledFailure('day', 10), true);

  const waiting = coordinator.observeExpectedPhase('day', HOUR);
  assert.equal(waiting.phaseChanged, false);
  assert.equal(waiting.reconciliation.kind, 'waiting');

  const retry = coordinator.observeExpectedPhase('day', HOUR + 10);
  assert.deepEqual(retry.reconciliation, { kind: 'retry', phase: 'day' });
  assert.equal(coordinator.markSuccess('day'), true);
  assert.deepEqual(
    coordinator.observeExpectedPhase('day', HOUR + 11).reconciliation,
    { kind: 'none' },
  );
});

test('detects a missed phase transition and cancels obsolete recovery', () => {
  const coordinator = new PhaseAutomationCoordinator(HOUR);
  coordinator.observeExpectedPhase('day', 0);
  coordinator.markScheduledFailure('day', 1);

  const observation = coordinator.observeExpectedPhase('night', 2);
  assert.equal(observation.phaseChanged, true);
  assert.equal(observation.previousExpectedPhase, 'day');
  assert.deepEqual(observation.reconciliation, { kind: 'cancelled', phase: 'day' });
  assert.equal(coordinator.markScheduledFailure('day', 3), undefined);
});

test('clearing automation state rejects failures from obsolete actions', () => {
  const coordinator = new PhaseAutomationCoordinator(HOUR);
  coordinator.observeExpectedPhase('night', 0);
  coordinator.markScheduledFailure('night', 1);

  assert.equal(coordinator.clear(), 'night');
  assert.equal(coordinator.isExpectedPhase('night'), false);
  assert.equal(coordinator.markScheduledFailure('night', 2), undefined);
});
