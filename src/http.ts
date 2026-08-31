import DigestClient from 'digest-fetch';
import fetch, { type RequestInit, type Response } from 'node-fetch';

export type AuthType = 'digest' | 'basic' | 'none';

export interface RequestDependencies {
  fetch?: typeof fetch;
  createDigestClient?: (username: string, password: string) => Pick<DigestClient, 'fetch'>;
}

export interface CameraRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  authType: AuthType;
  username?: string;
  password?: string;
  timeoutMs?: number;
  lifecycleSignal?: AbortSignal;
}

export type CameraResponseConsumer<T> = (
  response: Response,
  signal: AbortSignal,
) => Promise<T>;

export class CameraResponseConsumerError extends Error {
  readonly response: Response;

  constructor(response: Response, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Camera response consumption failed: ${detail}`, { cause });
    this.name = 'CameraResponseConsumerError';
    this.response = response;
  }
}

export async function withRetries<T>(
  work: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
    random?: () => number;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onRetry?: (attempt: number, totalAttempts: number, delayMs: number) => void;
  } = {},
): Promise<T> {
  let lastError: unknown;
  const attempts = Math.round(Math.min(10, Math.max(1, options.attempts || 1)));
  const baseDelayMs = Math.min(60_000, Math.max(0, options.baseDelayMs || 0));
  const random = options.random ?? Math.random;
  const wait = options.wait ?? abortableDelay;

  for (let index = 0; index < attempts; index++) {
    if (options.signal?.aborted) throw new Error('Operation aborted');

    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted) throw error;
      if (index >= attempts - 1) break;

      const jitter = Math.floor(random() * 250);
      const delayMs = Math.min(5 * 60_000, baseDelayMs * Math.pow(2, index) + jitter);
      options.onRetry?.(index + 1, attempts, delayMs);
      if (delayMs > 0) await wait(delayMs, options.signal);
    }
  }

  throw lastError;
}

export function abortableDelay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation aborted'));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRequestTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 10_000,
  lifecycleSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortForLifecycle = () => controller.abort();
  if (lifecycleSignal?.aborted) controller.abort();
  else lifecycleSignal?.addEventListener('abort', abortForLifecycle, { once: true });

  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let rejectForAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (controller.signal.aborted) rejectForAbort();
    else controller.signal.addEventListener('abort', rejectForAbort, { once: true });
  });

  try {
    return await Promise.race([
      work(controller.signal),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    if (rejectForAbort) controller.signal.removeEventListener('abort', rejectForAbort);
    lifecycleSignal?.removeEventListener('abort', abortForLifecycle);
  }
}

export function sendCameraRequest(
  request: CameraRequest,
  dependencies?: RequestDependencies,
): Promise<Response>;
export function sendCameraRequest<T>(
  request: CameraRequest,
  dependencies: RequestDependencies | undefined,
  consumeResponse: CameraResponseConsumer<T>,
): Promise<T>;
export async function sendCameraRequest<T>(
  request: CameraRequest,
  dependencies: RequestDependencies = {},
  consumeResponse?: CameraResponseConsumer<T>,
): Promise<Response | T> {
  const requestFetch = dependencies.fetch ?? fetch;
  const createDigestClient = dependencies.createDigestClient ??
    ((username: string, password: string) => new DigestClient(username, password));

  const headers = { ...request.headers };
  if (request.authType === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${request.username || ''}:${request.password || ''}`).toString('base64')}`;
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.body !== undefined) init.body = request.body;

  let receivedResponse: Response | undefined;
  try {
    return await withRequestTimeout(async signal => {
      let response: Response;
      if (request.authType === 'digest') {
        const client = createDigestClient(request.username || '', request.password || '');
        response = await client.fetch(request.url, { ...init, signal } as any) as Response;
      } else {
        response = await requestFetch(request.url, { ...init, signal });
      }
      receivedResponse = response;

      if (consumeResponse) return consumeResponse(response, signal);
      return response;
    }, request.timeoutMs, request.lifecycleSignal);
  } catch (error) {
    if (consumeResponse && receivedResponse && !(error instanceof CameraResponseConsumerError)) {
      throw new CameraResponseConsumerError(receivedResponse, error);
    }
    throw error;
  }
}
