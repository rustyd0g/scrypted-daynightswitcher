import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSolarEvents,
  expectedPhaseAt,
  nextEventForPhase,
} from '../src/schedule.ts';

const at = (iso: string) => new Date(iso);
const day = (date: string) => ({
  sunrise: at(`${date}T06:00:00.000Z`),
  sunset: at(`${date}T18:00:00.000Z`),
});

test('determines the normal phase from the most recent solar event', () => {
  const events = buildSolarEvents([day('2026-01-01')], 0, 0);

  assert.equal(expectedPhaseAt(events, at('2026-01-01T12:00:00.000Z')), 'day');
  assert.equal(expectedPhaseAt(events, at('2026-01-01T20:00:00.000Z')), 'night');
});

test('handles offsets that reverse the adjusted sunrise and sunset order', () => {
  const events = buildSolarEvents([
    day('2026-01-01'),
    day('2026-01-02'),
  ], 720, -720);

  assert.equal(expectedPhaseAt(events, at('2026-01-01T12:00:00.000Z')), 'night');
  assert.equal(expectedPhaseAt(events, at('2026-01-01T19:00:00.000Z')), 'day');
  assert.equal(expectedPhaseAt(events, at('2026-01-02T07:00:00.000Z')), 'night');
});

test('finds the next event when a negative offset moves the following event into the prior day', () => {
  const events = buildSolarEvents([
    day('2026-01-01'),
    day('2026-01-02'),
    day('2026-01-03'),
  ], -720, 0);

  const nextDay = nextEventForPhase(events, 'day', at('2026-01-01T23:00:00.000Z'));
  assert.equal(nextDay?.at.toISOString(), '2026-01-02T18:00:00.000Z');
});

test('resolves identical adjusted event times deterministically to night', () => {
  const events = buildSolarEvents([day('2026-01-01')], 360, -360);
  assert.equal(expectedPhaseAt(events, at('2026-01-01T12:00:00.000Z')), 'night');
});

test('treats an event at the current instant as the active phase', () => {
  const events = buildSolarEvents([day('2026-01-01')], 0, 0);
  assert.equal(expectedPhaseAt(events, at('2026-01-01T06:00:00.000Z')), 'day');
});

test('ignores invalid solar dates returned for polar locations', () => {
  const invalid = new Date(Number.NaN);
  const events = buildSolarEvents([{ sunrise: invalid, sunset: invalid }], 0, 0);

  assert.deepEqual(events, []);
  assert.equal(expectedPhaseAt(events, at('2026-01-01T12:00:00.000Z')), undefined);
  assert.equal(nextEventForPhase(events, 'day', at('2026-01-01T12:00:00.000Z')), undefined);
});
