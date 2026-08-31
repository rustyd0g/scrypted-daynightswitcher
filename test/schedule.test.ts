import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSolarEvents,
  expectedPhaseAt,
  nextEventForPhase,
  solarEventDayOffsets,
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

test('extends the input-day horizon when offsets can cross a calendar boundary', () => {
  assert.deepEqual(solarEventDayOffsets(0, 0), [-2, -1, 0, 1, 2]);
  assert.deepEqual(solarEventDayOffsets(0, 420), [-3, -2, -1, 0, 1, 2]);
  assert.deepEqual(solarEventDayOffsets(-720, 0), [-2, -1, 0, 1, 2, 3]);
  assert.deepEqual(solarEventDayOffsets(1441, -1441), [-4, -3, -2, -1, 0, 1, 2, 3, 4]);
});

test('includes the prior adjusted sunset at high latitude with a positive offset', () => {
  // SunCalc results for -54.8, -68.3 around 2026-01-01. At this latitude,
  // sunset falls on the following UTC date before the configured offset.
  const now = at('2026-01-01T05:00:00.000Z');
  const solarTimes = new Map<number, ReturnType<typeof day>>([
    [-2, {
      sunrise: at('2025-12-30T07:59:43.911Z'),
      sunset: at('2025-12-31T01:14:11.799Z'),
    }],
    [-1, {
      sunrise: at('2025-12-31T08:00:49.123Z'),
      sunset: at('2026-01-01T01:14:02.510Z'),
    }],
    [0, {
      sunrise: at('2026-01-01T08:01:57.966Z'),
      sunset: at('2026-01-02T01:13:49.100Z'),
    }],
    [1, {
      sunrise: at('2026-01-02T08:03:10.348Z'),
      sunset: at('2026-01-03T01:13:31.604Z'),
    }],
    [2, {
      sunrise: at('2026-01-03T08:04:26.177Z'),
      sunset: at('2026-01-04T01:13:10.059Z'),
    }],
  ]);
  const days = solarEventDayOffsets(0, 420)
    .map(offset => solarTimes.get(offset))
    .filter((times): times is ReturnType<typeof day> => !!times);
  const incompleteDays = [-1, 0, 1, 2]
    .map(offset => solarTimes.get(offset))
    .filter((times): times is ReturnType<typeof day> => !!times);

  const events = buildSolarEvents(days, 0, 420);

  assert.equal(expectedPhaseAt(buildSolarEvents(incompleteDays, 0, 420), now), 'day');
  assert.equal(expectedPhaseAt(events, now), 'night');
});

test('includes the prior sunset near the international date line', () => {
  const now = at('2026-01-01T00:05:00.000Z');
  const days = [
    {
      sunrise: at('2025-12-30T17:56:17.086Z'),
      sunset: at('2025-12-31T06:03:31.869Z'),
    },
    {
      sunrise: at('2025-12-31T17:56:45.094Z'),
      sunset: at('2026-01-01T06:03:59.640Z'),
    },
    {
      sunrise: at('2026-01-01T17:57:12.860Z'),
      sunset: at('2026-01-02T06:04:27.144Z'),
    },
  ];

  assert.equal(expectedPhaseAt(buildSolarEvents(days.slice(1), -720, 0), now), 'day');
  assert.equal(expectedPhaseAt(buildSolarEvents(days, -720, 0), now), 'night');
});
