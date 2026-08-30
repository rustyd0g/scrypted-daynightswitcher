export type DayNightPhase = 'day' | 'night';

export interface SunTimesForDay {
  sunrise: Date;
  sunset: Date;
}

export interface SolarEvent {
  at: Date;
  phase: DayNightPhase;
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
