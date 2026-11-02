import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isMixinProviderApplied } from '../src/mixin-lifecycle.ts';

test('recognises a stale release while the provider is still applied', () => {
  assert.equal(isMixinProviderApplied('provider', {
    mixins: ['other', 'provider'],
  }), true);
});

test('allows release after the provider has been removed', () => {
  assert.equal(isMixinProviderApplied('provider', {
    mixins: ['other'],
  }), false);
});

test('allows cleanup after the device has disappeared', () => {
  assert.equal(isMixinProviderApplied('provider', undefined), false);
});
