import type { DayNightPhase } from './schedule';

type PhaseRequest = {
  phase: DayNightPhase;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

export class SerializedPhaseQueue {
  private active?: PhaseRequest;
  private queued: PhaseRequest[] = [];
  private worker?: Promise<void>;
  private released = false;
  private readonly execute: (phase: DayNightPhase) => Promise<void>;

  constructor(execute: (phase: DayNightPhase) => Promise<void>) {
    this.execute = execute;
  }

  request(phase: DayNightPhase): Promise<void> {
    if (this.released) return Promise.reject(new Error('Phase queue has been released'));

    if (!this.queued.length && this.active?.phase === phase) {
      return this.active.promise;
    }

    const lastQueued = this.queued.at(-1);
    if (lastQueued?.phase === phase) return lastQueued.promise;

    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.queued.push({ phase, promise, resolve, reject });
    this.startWorker();
    return promise;
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
        await this.execute(request.phase);
        request.resolve();
      } catch (error) {
        request.reject(error);
      } finally {
        this.active = undefined;
      }
    }
  }
}
