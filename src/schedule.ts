export type DayNightPhase = 'day' | 'night';

export interface SunTimesForDay {
  sunrise: Date;
  sunset: Date;
}

export interface SolarEvent {
  at: Date;
  phase: DayNightPhase;
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * Return the input-day offsets needed to determine the current phase and the
 * next sunrise and sunset. The baseline accounts for solar events falling on
 * an adjacent UTC day. An adjusted event can cross another calendar-day
 * boundary, so extend the corresponding side for positive or negative
 * offsets.
 */
export function solarEventDayOffsets(
  sunriseOffsetMins: number,
  sunsetOffsetMins: number,
): number[] {
  const offsets = [sunriseOffsetMins, sunsetOffsetMins]
    .filter(Number.isFinite);
  const largestPositiveOffset = Math.max(0, ...offsets);
  const largestNegativeOffset = Math.min(0, ...offsets);
  const firstDay = -2 - Math.ceil(largestPositiveOffset / MINUTES_PER_DAY);
  const lastDay = 2 + Math.ceil(Math.abs(largestNegativeOffset) / MINUTES_PER_DAY);

  return Array.from(
    { length: lastDay - firstDay + 1 },
    (_, index) => firstDay + index,
  );
}

export function buildSolarEvents(
  days: SunTimesForDay[],
  sunriseOffsetMins: number,
  sunsetOffsetMins: number,
): SolarEvent[] {
  const sunriseOffsetMs = sunriseOffsetMins * 60_000;
  const sunsetOffsetMs = sunsetOffsetMins * 60_000;
  const events: SolarEvent[] = [];

  for (const day of days) {
    if (Number.isNaN(day.sunrise.getTime()) || Number.isNaN(day.sunset.getTime())) continue;
    events.push(
      { at: new Date(day.sunrise.getTime() + sunriseOffsetMs), phase: 'day' },
      { at: new Date(day.sunset.getTime() + sunsetOffsetMs), phase: 'night' },
    );
  }

  return events.sort((a, b) => {
    const byTime = a.at.getTime() - b.at.getTime();
    if (byTime) return byTime;
    // Match timer insertion order when both adjusted events are identical.
    return a.phase === b.phase ? 0 : a.phase === 'day' ? -1 : 1;
  });
}

export function expectedPhaseAt(events: SolarEvent[], now: Date): DayNightPhase | undefined {
  const nowMs = now.getTime();
  let latest: SolarEvent | undefined;

  for (const event of events) {
    if (event.at.getTime() > nowMs) break;
    latest = event;
  }

  return latest?.phase;
}

export function nextEventForPhase(
  events: SolarEvent[],
  phase: DayNightPhase,
  now: Date,
): SolarEvent | undefined {
  const nowMs = now.getTime();
  return events.find(event => event.phase === phase && event.at.getTime() > nowMs);
}
