import assert from 'node:assert/strict';
import { test } from 'node:test';

import { shouldMigrateLegacySyncOverride } from '../src/settings-migration.ts';

test('preserves the implicit legacy startup-sync default for location overrides', () => {
  assert.equal(shouldMigrateLegacySyncOverride({
    overrideSyncOnStartupStored: false,
    overrideLocationAndTime: true,
  }), true);
});

test('does not overwrite an explicit startup-sync override', () => {
  assert.equal(shouldMigrateLegacySyncOverride({
    overrideSyncOnStartupStored: true,
    overrideLocationAndTime: true,
  }), false);
});

test('does not migrate cameras that previously followed global settings', () => {
  assert.equal(shouldMigrateLegacySyncOverride({
    overrideSyncOnStartupStored: false,
    overrideLocationAndTime: false,
  }), false);
});
