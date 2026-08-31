import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  abortableDelay,
  CameraResponseConsumerError,
  sendCameraRequest,
  withRetries,
} from '../src/http.ts';

const responseWithText = (body: string) => ({ text: async () => body }) as any;

const abortingFetch = () => (async (_url: string, init: any) => {
  return new Promise((_resolve, reject) => {
    const rejectForAbort = () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    if (init.signal?.aborted) rejectForAbort();
    else init.signal?.addEventListener('abort', rejectForAbort, { once: true });
  });
}) as any;

test('sends unauthenticated and Basic authenticated requests', async () => {
  const requests: Array<{ url: string; init: any }> = [];
  const requestFetch = (async (url: string, init: any) => {
    requests.push({ url, init });
    return responseWithText('OK');
  }) as any;

  const none = await sendCameraRequest({
    url: 'http://camera.local/status',
    method: 'GET',
    headers: {},
    authType: 'none',
  }, { fetch: requestFetch });
  assert.equal(await none.text(), 'OK');

  const basic = await sendCameraRequest({
    url: 'http://camera.local/profile',
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain' },
    body: 'profile=day',
    authType: 'basic',
    username: 'camera',
    password: 'secret',
  }, { fetch: requestFetch });
  assert.equal(await basic.text(), 'OK');

  assert.equal(requests[0].init.headers.Authorization, undefined);
  assert.equal(requests[1].init.headers.Authorization, 'Basic Y2FtZXJhOnNlY3JldA==');
  assert.equal(requests[1].init.body, 'profile=day');
  assert.equal(requests[1].init.method, 'PUT');
});

test('uses the Digest client with the configured credentials', async () => {
  let credentials: [string, string] | undefined;
  let requestedUrl: string | undefined;

  const response = await sendCameraRequest({
    url: 'http://camera.local/day',
    method: 'GET',
    headers: {},
    authType: 'digest',
    username: 'digest-user',
    password: 'digest-password',
  }, {
    createDigestClient: (username, password) => {
      credentials = [username, password];
      return {
        fetch: (async (url: string) => {
          requestedUrl = url;
          return {
            text: async () => 'OK',
          } as any;
        }) as any,
      };
    },
  });

  assert.deepEqual(credentials, ['digest-user', 'digest-password']);
  assert.equal(requestedUrl, 'http://camera.local/day');
  assert.equal(await response.text(), 'OK');
});

test('retries with exponential backoff and deterministic jitter', async () => {
  let calls = 0;
  const delays: number[] = [];

  const result = await withRetries(async () => {
    calls++;
    if (calls < 3) throw new Error(`failure ${calls}`);
    return 'success';
  }, {
    attempts: 3,
    baseDelayMs: 100,
    random: () => 0,
    wait: async delay => { delays.push(delay); },
  });

  assert.equal(result, 'success');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
});

test('aborts a pending retry delay during lifecycle cleanup', async () => {
  const controller = new AbortController();
  const pending = abortableDelay(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
});

test('does not start another retry after the operation is aborted', async () => {
  const controller = new AbortController();
  let calls = 0;
  let retryNotifications = 0;

  const pending = withRetries(async () => {
    calls++;
    controller.abort();
    throw new Error('cancelled action');
  }, {
    attempts: 3,
    signal: controller.signal,
    onRetry: () => retryNotifications++,
  });

  await assert.rejects(pending, /cancelled action/);
  assert.equal(calls, 1);
  assert.equal(retryNotifications, 0);
});

test('times out an HTTP request that does not respond promptly', async () => {
  await assert.rejects(sendCameraRequest({
    url: 'http://camera.local/slow',
    method: 'GET',
    headers: {},
    authType: 'none',
    timeoutMs: 10,
  }, { fetch: abortingFetch() }), error => (error as Error).name === 'AbortError');
});

test('aborts an active HTTP request when the lifecycle signal is cancelled', async () => {
  const controller = new AbortController();
  const pending = sendCameraRequest({
    url: 'http://camera.local/slow',
    method: 'GET',
    headers: {},
    authType: 'none',
    timeoutMs: 1_000,
    lifecycleSignal: controller.signal,
  }, { fetch: abortingFetch() });
  controller.abort();
  await assert.rejects(pending, error => (error as Error).name === 'AbortError');
});

test('keeps the request timeout active while consuming the response', async () => {
  let consumerSignal: AbortSignal | undefined;
  const response = responseWithText('OK');
  const requestFetch = (async () => response) as any;

  const pending = sendCameraRequest({
    url: 'http://camera.local/slow-body',
    method: 'GET',
    headers: {},
    authType: 'none',
    timeoutMs: 10,
  }, { fetch: requestFetch }, async (_response, signal) => {
    consumerSignal = signal;
    return new Promise<string>(() => {});
  });

  await assert.rejects(pending, error => {
    assert.ok(error instanceof CameraResponseConsumerError);
    assert.equal(error.response, response);
    assert.equal((error.cause as Error).name, 'AbortError');
    return true;
  });
  assert.equal(consumerSignal?.aborted, true);
});

test('keeps lifecycle cancellation active while consuming the response', async () => {
  const controller = new AbortController();
  let consumerSignal: AbortSignal | undefined;
  const response = responseWithText('OK');
  const requestFetch = (async () => response) as any;

  const pending = sendCameraRequest({
    url: 'http://camera.local/slow-body',
    method: 'GET',
    headers: {},
    authType: 'none',
    timeoutMs: 1_000,
    lifecycleSignal: controller.signal,
  }, { fetch: requestFetch }, async (_response, signal) => {
    consumerSignal = signal;
    return new Promise<string>(() => {});
  });

  controller.abort();
  await assert.rejects(pending, error => {
    assert.ok(error instanceof CameraResponseConsumerError);
    assert.equal(error.response, response);
    assert.equal((error.cause as Error).name, 'AbortError');
    return true;
  });
  assert.equal(consumerSignal?.aborted, true);
});

test('preserves the response and cause when response consumption fails', async () => {
  const response = responseWithText('OK');
  const readError = new Error('response body failed');
  const requestFetch = (async () => response) as any;

  const pending = sendCameraRequest({
    url: 'http://camera.local/broken-body',
    method: 'GET',
    headers: {},
    authType: 'none',
  }, { fetch: requestFetch }, async () => {
    throw readError;
  });

  await assert.rejects(pending, error => {
    assert.ok(error instanceof CameraResponseConsumerError);
    assert.equal(error.response, response);
    assert.equal(error.cause, readError);
    return true;
  });
});
