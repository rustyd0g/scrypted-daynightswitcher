import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  abortableDelay,
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
