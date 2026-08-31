import type { DayNightPhase } from './schedule';

export type ReconciliationDecision =
  | { kind: 'none' }
  | { kind: 'waiting'; phase: DayNightPhase; nextAttemptAt: number }
  | { kind: 'retry'; phase: DayNightPhase }
  | { kind: 'cancelled'; phase: DayNightPhase };

export type ExpectedPhaseObservation = {
  expectedPhase: DayNightPhase;
  previousExpectedPhase?: DayNightPhase;
  phaseChanged: boolean;
  reconciliation: ReconciliationDecision;
};

type PendingReconciliation = {
  phase: DayNightPhase;
  nextAttemptAt: number;
  inFlight: boolean;
};

export class PhaseReconciler {
  private pending?: PendingReconciliation;
  private readonly retryIntervalMs: number;

  constructor(retryIntervalMs = 60 * 60_000) {
    this.retryIntervalMs = retryIntervalMs;
  }

  markScheduledFailure(phase: DayNightPhase, now = Date.now()) {
    const isNew = this.pending?.phase !== phase;
    this.pending = {
      phase,
      nextAttemptAt: now + this.retryIntervalMs,
      inFlight: false,
    };
    return isNew;
  }

  evaluate(expectedPhase: DayNightPhase, now = Date.now()): ReconciliationDecision {
    const pending = this.pending;
    if (!pending) return { kind: 'none' };

    if (pending.phase !== expectedPhase) {
      this.pending = undefined;
      return { kind: 'cancelled', phase: pending.phase };
    }

    if (pending.inFlight || now < pending.nextAttemptAt) {
      return {
        kind: 'waiting',
        phase: pending.phase,
        nextAttemptAt: pending.nextAttemptAt,
      };
    }

    pending.inFlight = true;
    return { kind: 'retry', phase: pending.phase };
  }

  markAttemptFailure(phase: DayNightPhase, now = Date.now()) {
    if (this.pending?.phase !== phase) return false;
    this.pending.inFlight = false;
    this.pending.nextAttemptAt = now + this.retryIntervalMs;
    return true;
  }

  markSuccess(phase: DayNightPhase) {
    if (this.pending?.phase !== phase) return false;
    this.pending = undefined;
    return true;
  }

  clear() {
    const phase = this.pending?.phase;
    this.pending = undefined;
    return phase;
  }
}

/**
 * Coordinates the calculated phase with recovery of failed automatic actions.
 * Keeping both pieces of state together lets schedule checks detect a phase
 * transition even when the timer for that transition was cleared before it ran.
 */
export class PhaseAutomationCoordinator {
  private expectedPhase?: DayNightPhase;
  private readonly reconciler: PhaseReconciler;

  constructor(retryIntervalMs = 60 * 60_000) {
    this.reconciler = new PhaseReconciler(retryIntervalMs);
  }

  observeExpectedPhase(
    expectedPhase: DayNightPhase,
    now = Date.now(),
  ): ExpectedPhaseObservation {
    const previousExpectedPhase = this.expectedPhase;
    this.expectedPhase = expectedPhase;

    return {
      expectedPhase,
      previousExpectedPhase,
      phaseChanged: previousExpectedPhase !== undefined && previousExpectedPhase !== expectedPhase,
      reconciliation: this.reconciler.evaluate(expectedPhase, now),
    };
  }

  isExpectedPhase(phase: DayNightPhase) {
    return this.expectedPhase === phase;
  }

  markScheduledFailure(phase: DayNightPhase, now = Date.now()): boolean | undefined {
    if (!this.isExpectedPhase(phase)) return undefined;
    return this.reconciler.markScheduledFailure(phase, now);
  }

  markAttemptFailure(phase: DayNightPhase, now = Date.now()) {
    if (!this.isExpectedPhase(phase)) return false;
    return this.reconciler.markAttemptFailure(phase, now);
  }

  markSuccess(phase: DayNightPhase) {
    return this.reconciler.markSuccess(phase);
  }

  clear() {
    this.expectedPhase = undefined;
    return this.reconciler.clear();
  }
}
