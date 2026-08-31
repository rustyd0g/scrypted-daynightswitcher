import type { DayNightPhase } from './schedule';

export type PhaseRequestSource = 'manual' | 'automatic';

export type PhaseRequestContext = Readonly<{
  source: PhaseRequestSource;
  scheduleGeneration?: number;
  expectedPhase?: DayNightPhase;
}>;

export type QueuedPhaseRequest = Readonly<{
  phase: DayNightPhase;
  context?: PhaseRequestContext;
}>;

export class PhaseQueueCancellationError extends Error {
  constructor(message = 'Phase request cancelled before execution') {
    super(message);
    this.name = 'PhaseQueueCancellationError';
  }
}

type PhaseRequest = {
  phase: DayNightPhase;
  context?: PhaseRequestContext;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

function contextsMatch(
  first: PhaseRequestContext | undefined,
  second: PhaseRequestContext | undefined,
): boolean {
  if (!first || !second) return first === second;
  return first.source === second.source
    && first.scheduleGeneration === second.scheduleGeneration
    && first.expectedPhase === second.expectedPhase;
}

function requestsMatch(
  request: PhaseRequest,
  phase: DayNightPhase,
  context: PhaseRequestContext | undefined,
): boolean {
  return request.phase === phase && contextsMatch(request.context, context);
}

export class SerializedPhaseQueue {
  private active?: PhaseRequest;
  private queued: PhaseRequest[] = [];
  private worker?: Promise<void>;
  private released = false;
  private readonly execute: (
    phase: DayNightPhase,
    context?: PhaseRequestContext,
  ) => Promise<void>;

  constructor(execute: (
    phase: DayNightPhase,
    context?: PhaseRequestContext,
  ) => Promise<void>) {
    this.execute = execute;
  }

  request(phase: DayNightPhase, context?: PhaseRequestContext): Promise<void> {
    if (this.released) return Promise.reject(new Error('Phase queue has been released'));

    if (!this.queued.length && this.active && requestsMatch(this.active, phase, context)) {
      return this.active.promise;
    }

    const lastQueued = this.queued.at(-1);
    if (lastQueued && requestsMatch(lastQueued, phase, context)) return lastQueued.promise;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queued.push({
      phase,
      context: context ? { ...context } : undefined,
      promise,
      resolve,
      reject,
    });
    this.startWorker();
    return promise;
  }

  cancelQueued(
    predicate: (request: QueuedPhaseRequest) => boolean,
    error: unknown = new PhaseQueueCancellationError(),
  ): number {
    const cancelled: PhaseRequest[] = [];
    const remaining: PhaseRequest[] = [];

    for (const request of this.queued) {
      if (!predicate({ phase: request.phase, context: request.context })) {
        remaining.push(request);
        continue;
      }

      cancelled.push(request);
    }

    this.queued = remaining;
    for (const request of cancelled) request.reject(error);
    return cancelled.length;
  }

  release(error = new Error('Phase queue released before the queued action could run')) {
    if (this.released) return;
    this.released = true;
    for (const request of this.queued.splice(0)) request.reject(error);
  }

  private startWorker() {
    if (this.worker) return;

    const worker = this.drain();
    this.worker = worker;
    worker.finally(() => {
      if (this.worker === worker) this.worker = undefined;
      if (this.queued.length && !this.released) this.startWorker();
    }).catch(() => {});
  }

  private async drain() {
    while (!this.released && this.queued.length) {
      const request = this.queued.shift()!;
      this.active = request;
      try {
        await this.execute(request.phase, request.context);
        request.resolve();
      } catch (error) {
        request.reject(error);
      } finally {
        this.active = undefined;
      }
    }
  }
}
