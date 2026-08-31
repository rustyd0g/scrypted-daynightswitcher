import {
  ScryptedDeviceBase,
  MixinProvider,
  ScryptedInterface,
  ScryptedDeviceType,
  Setting,
  SettingValue,
  WritableDeviceState,
} from '@scrypted/sdk';

import { SettingsMixinDeviceBase, SettingsMixinDeviceOptions } from '@scrypted/sdk/settings-mixin';

import * as SunCalc from 'suncalc';
import {
  AuthType,
  CameraResponseConsumerError,
  sendCameraRequest,
  withRetries,
} from './http';
import {
  PhaseQueueCancellationError,
  PhaseRequestContext,
  SerializedPhaseQueue,
} from './phase-queue';
import {
  PhaseAutomationCoordinator,
  ReconciliationDecision,
} from './reconciliation';
import {
  DayNightPhase,
  buildSolarEvents,
  expectedPhaseAt,
  nextEventForPhase,
  solarEventDayOffsets,
} from './schedule';
import { shouldMigrateLegacySyncOverride } from './settings-migration';

const GROUP = 'Day/Night Switcher';
const GROUP_KEY = 'dayNightSwitcher';
const MAX_DELAY_MS = 2_147_483_647;

const mixinsById = new Map<string, DayNightMixin>();
let mixinsByDevice = new WeakMap<any, DayNightMixin>();

function isNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function combineAbortSignals(signals: AbortSignal[]) {
  const controller = new AbortController();
  const abort = () => controller.abort();

  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of signals) signal.removeEventListener('abort', abort);
    },
  };
}

function normaliseSetting(key: string, value: SettingValue): SettingValue {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  const asNumber = (v: any) => (typeof v === 'number' ? v : Number(v));
  const isNumLike = (v: any) =>
    typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)));

  // normalise global.* keys to the per-camera key names for reuse
  const k = ({
    'global.latitude': 'latitude',
    'global.longitude': 'longitude',
    'global.sunriseOffsetMins': 'sunriseOffsetMins',
    'global.sunsetOffsetMins': 'sunsetOffsetMins',
    'global.retries': 'retries',
    'global.retryBaseDelayMs': 'retryBaseDelayMs',
  } as Record<string, string>)[key] ?? key;

  switch (k) {
    case 'latitude':
      return isNumLike(value) ? String(clamp(asNumber(value), -90, 90)) : value;

    case 'longitude':
      return isNumLike(value) ? String(clamp(asNumber(value), -180, 180)) : value;

    case 'sunriseOffsetMins':
    case 'sunsetOffsetMins':
      return isNumLike(value) ? String(clamp(asNumber(value), -720, 720)) : value;

    case 'retries':
      return isNumLike(value) ? String(Math.round(clamp(asNumber(value), 1, 10))) : value;

    case 'retryBaseDelayMs':
      return isNumLike(value) ? String(Math.round(clamp(asNumber(value), 0, 60_000))) : value;

    case 'authType': {
      const authType = String(value ?? 'digest').trim().toLowerCase();
      return ['digest', 'basic', 'none'].includes(authType) ? authType : 'digest';
    }

    case 'day.url':
    case 'night.url':
      return value == null ? '' : String(value).trim();

    case 'day.method':
    case 'night.method': {
      const allowed = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
      let m = String(value ?? 'GET').trim().toUpperCase();
      if (!allowed.has(m)) m = 'GET';
      return m;
    }

    default:
      return value;
  }
}

/* SunCalc memoization: per (lat, lon, local day). */
type SunTimes = Pick<ReturnType<typeof SunCalc.getTimes>, 'sunrise' | 'sunset'>;

const sunTimesCache = new Map<string, SunTimes>();
const SUN_TIMES_CACHE_LIMIT = 1000;
const KEY_PRECISION_DP = 6;

function localDayKey(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sunKey(lat: number, lon: number, date: Date) {
  const lt = lat.toFixed(KEY_PRECISION_DP);
  const ln = lon.toFixed(KEY_PRECISION_DP);
  return `${lt},${ln}|${localDayKey(date)}`;
}

function getSunTimesCached(date: Date, lat: number, lon: number): SunTimes {
  // SunCalc selects a solar cycle from the supplied instant. Normalising to
  // local noon keeps every lookup for a calendar date on the same cycle and
  // makes the local-day cache key valid around midnight.
  const solarDate = new Date(date);
  solarDate.setHours(12, 0, 0, 0);
  const key = sunKey(lat, lon, solarDate);
  const hit = sunTimesCache.get(key);
  if (hit) {
    // LRU bump
    sunTimesCache.delete(key);
    sunTimesCache.set(key, hit);
    return { sunrise: new Date(hit.sunrise), sunset: new Date(hit.sunset) };
  }

  const t = SunCalc.getTimes(solarDate, lat, lon);
  const value: SunTimes = { sunrise: new Date(t.sunrise), sunset: new Date(t.sunset) };
  sunTimesCache.set(key, value);

  if (sunTimesCache.size > SUN_TIMES_CACHE_LIMIT) {
    const oldest = sunTimesCache.keys().next().value;
    if (oldest) sunTimesCache.delete(oldest);
  }

  return { sunrise: new Date(value.sunrise), sunset: new Date(value.sunset) };
}

/* ---------------- Per-camera mixin ---------------- */

type DayNightMixinOptions = SettingsMixinDeviceOptions<any> & {
  getGlobal: (key: string) => string | undefined;
};

class DayNightMixin extends SettingsMixinDeviceBase<any> {
  private timers: NodeJS.Timeout[] = [];
  private settingsState = new Map<string, any>();
  private getGlobal: (key: string) => string | undefined;
  private deviceHandle: any;

  // race-safety & lifecycle flags
  private globalsDebounce?: NodeJS.Timeout;
  private isRescheduling = false;
  private rescheduleQueued = false;
  private released = false;
  private scheduleVersion = 0;
  private initialSyncPending = true;

  // Camera actions are serialized and duplicate requests are coalesced.
  private phaseSwitchQueue = new SerializedPhaseQueue(
    (phase, context) => this.switchPhase(phase, context),
  );
  private phaseAutomation = new PhaseAutomationCoordinator();
  private automaticGeneration = 0;
  private activeAutomaticAction?: {
    phase: DayNightPhase;
    controller: AbortController;
  };
  private lifecycleAbort = new AbortController();

  // heartbeat watchdog (interval)
  private heartbeat?: NodeJS.Timeout;

  constructor(options: DayNightMixinOptions) {
    super(options);
    this.deviceHandle = options.mixinDevice;
    this.getGlobal = options.getGlobal;
    this.loadSettingsFromStorage();
    setTimeout(() => {
      if (!this.released) this.initializeScheduling();
    }, 250);
  }

  getDeviceHandle() { return this.deviceHandle; }

  notifyGlobalsChanged() {
    if (this.released) return;

    this.console?.log?.('[Day/Night] Globals changed → reschedule');

    if (this.globalsDebounce) {
      clearTimeout(this.globalsDebounce);
      this.globalsDebounce = undefined;
    }

    this.globalsDebounce = setTimeout(() => {
      this.globalsDebounce = undefined;

      if (this.isRescheduling) {
        this.rescheduleQueued = true;
        return;
      }

      this.rescheduleAll().catch(e =>
        this.console?.error?.('Reschedule after globals change failed:', e)
      );
    }, 300);
  }

  private loadSettingsFromStorage() {
    const keys = [
      'enabled',
      'overrideLocationAndTime', 'overrideReliability', 'overrideOffsets', 'overrideSyncOnStartup',
      'sunriseOffsetMins', 'sunsetOffsetMins',
      'latitude', 'longitude', 'timeZone', 'use24h', 'syncOnStartup',
      'retries', 'retryBaseDelayMs', 'logResponses',
      'authType', 'username', 'password',
      'day.url', 'day.method', 'day.contentType', 'day.headers', 'day.body',
      'night.url', 'night.method', 'night.contentType', 'night.headers', 'night.body',
      'preview', 'previewHtml',
      'lastPhase', 'lastPhaseAt',
    ];

    for (const key of keys) {
      const value = this.storage.getItem(key);
      if (value !== null && value !== undefined) {
        this.settingsState.set(key, value);
      }
    }

    const defaults = {
      enabled: 'false',
      overrideLocationAndTime: 'false',
      overrideReliability: 'false',
      overrideOffsets: 'false',
      overrideSyncOnStartup: 'false',
      sunriseOffsetMins: '0',
      sunsetOffsetMins: '0',
      use24h: 'true',
      syncOnStartup: 'true',
      authType: 'digest',
      'day.method': 'GET',
      'night.method': 'GET',
      preview: '—',
      previewHtml: '<div style="opacity:.7">Click “Preview schedule”.</div>',
    } as const;

    for (const [key, val] of Object.entries(defaults)) {
      if (!this.settingsState.has(key)) this.settingsState.set(key, val);
    }

    // Preserve the behavior of older versions where the location/time
    // override also selected the per-camera startup-sync value. This includes
    // its implicit true default when syncOnStartup was never stored.
    if (shouldMigrateLegacySyncOverride({
      overrideSyncOnStartupStored: this.storage.getItem('overrideSyncOnStartup') != null,
      overrideLocationAndTime: this.getValue('overrideLocationAndTime') === 'true',
    })) {
      this.saveToStorage('overrideSyncOnStartup', 'true');
    }

    this.console?.log?.('[Day/Night] Settings loaded from storage');
  }

  private initializeScheduling() {
    if (this.getValue('enabled') === 'true') {
      this.rescheduleAll().catch(e => {
        this.console?.error?.('[Day/Night] Failed to initialise scheduling:', e);
      });
    }
  }

  private saveToStorage(key: string, value: any) {
    this.settingsState.set(key, value);
    try {
      this.storage.setItem(key, value?.toString() || '');
    } catch (error: any) {
      this.console?.warn?.(`[Day/Night] Error saving ${key} to storage:`, error.message);
    }
  }

  private getValue(key: string, def?: any): any {
    const v = this.settingsState.get(key);
    return v !== undefined ? v : def;
  }

  /* ---------- Settings UI (per device, tabbed) ---------- */

  async getMixinSettings(): Promise<Setting[]> {
    const overrideLoc = this.getValue('overrideLocationAndTime', 'false') === 'true';
    const overrideRel = this.getValue('overrideReliability', 'false') === 'true';
    const overrideOff = this.getValue('overrideOffsets', 'false') === 'true';
    const overrideSync = this.getValue('overrideSyncOnStartup', 'false') === 'true';

    const g = (k: string) => this.getGlobal?.(k);
    const glat = g?.('latitude') ?? '';
    const glon = g?.('longitude') ?? '';
    const gtz  = g?.('timeZone') ?? '';
    const g24h = (g?.('use24h') ?? 'true') === 'true';
    const gSunriseOff = g?.('sunriseOffsetMins') ?? '0';
    const gSunsetOff  = g?.('sunsetOffsetMins') ?? '0';
    const gSync = (g?.('syncOnStartup') ?? 'true') === 'true';

    const settings: Setting[] = [];

    // General
    settings.push({
      key: 'enabled',
      title: 'Enable Day/Night switching',
      group: GROUP,
      subgroup: 'General',
      type: 'boolean' as const,
      value: this.getValue('enabled', 'false') === 'true',
      description: 'Turn the automatic switching on for this camera.',
    });

    settings.push(
      {
        key: 'preview_html',
        title: 'Schedule preview',
        group: GROUP,
        subgroup: 'General',
        type: 'html' as const,
        readonly: true,
        value: this.getValue('previewHtml', '<div style="opacity:.7">Click “Preview schedule”.</div>'),
      },
      {
        key: 'last_success',
        title: 'Last successful action',
        group: GROUP,
        subgroup: 'General',
        type: 'string' as const,
        readonly: true,
        value: this.lastSuccessText(),
      },
      {
        key: '__btn_preview',
        title: 'Refresh preview',
        group: GROUP,
        subgroup: 'General',
        type: 'button' as const,
        description: 'Recalculate sunrise/sunset and next switches.',
      },
      {
        key: '__btn_day',
        title: 'Switch to Day now',
        group: GROUP,
        subgroup: 'General',
        type: 'button' as const,
      },
      {
        key: '__btn_night',
        title: 'Switch to Night now',
        group: GROUP,
        subgroup: 'General',
        type: 'button' as const,
      },
    );

    // Location & Time
    settings.push({
      key: 'overrideLocationAndTime',
      title: 'Override location & time for this camera',
      group: GROUP,
      subgroup: 'General',
      type: 'boolean' as const,
      value: overrideLoc,
      description: 'Tick to use camera-specific latitude/longitude/time. If off, this camera uses the Global Settings.',
    });

    if (!overrideLoc) {
      settings.push({
        key: 'loc_hint',
        title: 'Using global settings',
        group: GROUP,
        subgroup: 'General',
        type: 'string' as const,
        readonly: true,
        value: `Latitude ${glat || '—'}, Longitude ${glon || '—'}${gtz ? `, Time zone ${gtz}` : ''}${g24h ? ', 24-hour time' : ', 12-hour time'}`,
        description: 'Change these on the provider’s General tab, or tick the override above to set camera-specific values.',
      });
    } else {
      settings.push(
        {
          key: 'latitude',
          title: 'Latitude',
          group: GROUP,
          subgroup: 'General',
          type: 'number' as const,
          value: this.getValue('latitude', ''),
          placeholder: '51.507351',
          description:
            'Decimal degrees. Example: 51.507351 (central London). 6 decimal places is plenty (~11 cm). Valid range −90 to 90.',
        },
        {
          key: 'longitude',
          title: 'Longitude',
          group: GROUP,
          subgroup: 'General',
          type: 'number' as const,
          value: this.getValue('longitude', ''),
          placeholder: '-0.127758',
          description:
            'Decimal degrees. Example: −0.127758 (central London). 6 decimal places is plenty. Valid range −180 to 180.',
        },
        {
          key: 'timeZone',
          title: 'Time zone (optional)',
          group: GROUP,
          subgroup: 'General',
          type: 'string' as const,
          value: this.getValue('timeZone', ''),
          placeholder: 'Europe/London',
          description: 'IANA time zone (e.g. “Europe/London”). Leave blank to use the server’s time zone.',
        },
        {
          key: 'use24h',
          title: 'Use 24-hour time',
          group: GROUP,
          subgroup: 'General',
          type: 'boolean' as const,
          value: this.getValue('use24h', 'true') === 'true',
          description: 'Display times in 24-hour format (e.g. 17:30).',
        },
      );
    }

    settings.push({
      key: 'overrideSyncOnStartup',
      title: 'Override startup sync for this camera',
      group: GROUP,
      subgroup: 'General',
      type: 'boolean' as const,
      value: overrideSync,
      description: 'If off, this camera uses the Global startup sync setting.',
    });

    if (overrideSync) {
      settings.push({
        key: 'syncOnStartup',
        title: 'Sync phase on startup',
        group: GROUP,
        subgroup: 'General',
        type: 'boolean' as const,
        value: this.getValue('syncOnStartup', 'true') === 'true',
        description: 'Send the expected Day/Night action once when this camera mixin starts or switching is enabled.',
      });
    } else {
      settings.push({
        key: 'sync_hint',
        title: 'Using global startup sync',
        group: GROUP,
        subgroup: 'General',
        type: 'string' as const,
        readonly: true,
        value: gSync ? 'Enabled' : 'Disabled',
      });
    }

    // Offsets (global default with per-camera override)
    settings.push({
      key: 'overrideOffsets',
      title: 'Override sunrise/sunset offsets for this camera',
      group: GROUP,
      subgroup: 'General',
      type: 'boolean' as const,
      value: overrideOff,
      description: 'If off, this camera uses the Global offsets from the provider’s General tab.',
    });

    if (!overrideOff) {
      settings.push({
        key: 'off_hint',
        title: 'Using global offsets',
        group: GROUP,
        subgroup: 'General',
        type: 'string' as const,
        readonly: true,
        value: `Sunrise offset ${gSunriseOff} min, Sunset offset ${gSunsetOff} min`,
        description: 'Change these on the provider’s General tab, or tick the override above to set camera-specific offsets.',
      });
    } else {
      settings.push(
        {
          key: 'sunriseOffsetMins',
          title: 'Sunrise offset (mins)',
          group: GROUP,
          subgroup: 'General',
          type: 'number' as const,
          value: this.getValue('sunriseOffsetMins', '0'),
          description: 'Positive = after sunrise; negative = before.',
        },
        {
          key: 'sunsetOffsetMins',
          title: 'Sunset offset (mins)',
          group: GROUP,
          subgroup: 'General',
          type: 'number' as const,
          value: this.getValue('sunsetOffsetMins', '0'),
          description: 'Positive = after sunset; negative = before.',
        },
      );
    }

    // Authentication
    settings.push(
      {
        key: 'authType',
        title: 'Auth Type',
        group: GROUP,
        subgroup: 'Authentication',
        type: 'string' as const,
        value: this.getValue('authType', 'digest'),
        choices: ['digest', 'basic', 'none'],
        combobox: true,
        description: 'Authentication mode for the camera HTTP endpoint.',
      },
      {
        key: 'username',
        title: 'Username',
        group: GROUP,
        subgroup: 'Authentication',
        type: 'string' as const,
        value: this.getValue('username', ''),
      },
      {
        key: 'password',
        title: 'Password',
        group: GROUP,
        subgroup: 'Authentication',
        type: 'password' as const,
        value: this.getValue('password', ''),
        description: 'Stored in plain text by Scrypted.',
      },
    );

    // Day / Night actions
    settings.push(...this.actionSettings('day', 'Day'));
    settings.push(...this.actionSettings('night', 'Night'));

    // Reliability & Logging
    settings.push({
      key: 'overrideReliability',
      title: 'Override reliability for this camera',
      group: GROUP,
      subgroup: 'Reliability & Logging',
      type: 'boolean' as const,
      value: overrideRel,
      description: 'Set retries/back-off/logging for this camera only.',
    });

    if (overrideRel) {
      settings.push(
        {
          key: 'retries',
          title: 'HTTP total attempts',
          group: GROUP,
          subgroup: 'Reliability & Logging',
          type: 'number' as const,
          value: this.getValue('retries', ''),
          description: 'Total tries including the first attempt (1–10). Set 1 to disable retries.',
        },
        {
          key: 'retryBaseDelayMs',
          title: 'Retry base delay (ms)',
          group: GROUP,
          subgroup: 'Reliability & Logging',
          type: 'number' as const,
          value: this.getValue('retryBaseDelayMs', ''),
          description: 'Base delay for exponential back-off (0–60000 ms); jitter is added.',
        },
        {
          key: 'logResponses',
          title: 'Log HTTP responses',
          group: GROUP,
          subgroup: 'Reliability & Logging',
          type: 'boolean' as const,
          value: this.getValue('logResponses', 'false') === 'true',
          description: 'Log status and the response body (chunked, capped at ~64 KB).',
        },
      );
    }

    return settings;
  }

  private settingValueForLog(key: string, value: SettingValue) {
    if (key === 'password' || key === 'username' || key.endsWith('.headers') || key.endsWith('.body')) {
      return '[redacted]';
    }
    if (key.endsWith('.url')) return value ? '[configured URL]' : '[empty URL]';
    return `${value} (type: ${typeof value})`;
  }

  async putMixinSetting(key: string, value: SettingValue) {
    if (this.released) return;
    this.console?.log?.(`[Day/Night] Setting ${key} = ${this.settingValueForLog(key, value)}`);

    if (key === '__btn_preview') { await this.previewSchedule(); return; }
    if (key === '__btn_day')     { if (this.getValue('enabled') !== 'true') this.console?.log?.('[Day/Night] Manual Day with switching disabled.'); await this.requestPhaseSwitch('day'); return; }
    if (key === '__btn_night')   { if (this.getValue('enabled') !== 'true') this.console?.log?.('[Day/Night] Manual Night with switching disabled.'); await this.requestPhaseSwitch('night'); return; }

    value = normaliseSetting(key, value);

    if (key === 'enabled' && (value === true || value === 'true')) {
      const dayUrl = this.getValue('day.url', '');
      const nightUrl = this.getValue('night.url', '');
      if (!dayUrl || !nightUrl) {
        this.console?.warn?.('[Day/Night] Enabled but Day and/or Night URLs are not configured.');
      }
    }

    let storageValue = value;
    if (typeof value === 'boolean') storageValue = value ? 'true' : 'false';
    this.saveToStorage(key, storageValue);

    if ((key === 'enabled' || key === 'syncOnStartup') && storageValue === 'true') {
      this.initialSyncPending = true;
    }

    if ([
      'enabled',
      'overrideLocationAndTime', 'overrideReliability', 'overrideOffsets', 'overrideSyncOnStartup',
      'latitude', 'longitude', 'timeZone', 'use24h', 'syncOnStartup',
      'sunriseOffsetMins', 'sunsetOffsetMins',
      'retries', 'retryBaseDelayMs', 'logResponses',
    ].includes(key)) {
      const isEnabling = (key === 'enabled' && (value === true || value === 'true'));
      const isEnabled  = this.getValue('enabled') === 'true';
      if (isEnabling || (key !== 'enabled' && isEnabled)) {
        this.console?.log?.('[Day/Night] Rescheduling due to setting change');
        this.rescheduleAll().catch(e => this.console?.error?.('[Day/Night] Failed to reschedule:', e));
      } else if (key === 'enabled' && (value === false || value === 'false')) {
        this.console?.log?.('[Day/Night] Disabling schedules');
        this.scheduleVersion++;
        const cancelledPhase = this.phaseAutomation.clear();
        if (cancelledPhase) {
          this.console?.log?.(`[Day/Night] Cancelled pending ${cancelledPhase} reconciliation because switching was disabled.`);
        }
        this.cancelObsoleteAutomaticActions(undefined, true);
        this.clearTimers();
        this.stopHeartbeat();
        this.saveToStorage('preview', 'Switching is disabled');
        this.saveToStorage('previewHtml', '<div style="opacity:.7">Switching is disabled.</div>');
      }
    }
  }

  /* ---------- helpers ---------- */

  private n(k: string) {
    const s = this.getValue(k);
    if (s === '' || s === undefined || s === null) return undefined;
    const x = Number(s);
    return Number.isFinite(x) ? x : undefined;
  }

  private getString(k: string, def?: string) {
    const val = this.getValue(k, def);
    return val !== undefined && val !== null ? String(val) : def;
  }

  private getBool(k: string, def = false) {
    const val = this.getValue(k);
    if (val === true || val === 'true') return true;
    if (val === false || val === 'false') return false;
    return def;
  }

  private allowBody(method: string) {
    return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
  }

  private static readonly MAX_LOG_BYTES = 64 * 1024; // 64KB safety cap

  private logBodyChunks(
    phase: DayNightPhase,
    statusLine: string,
    body: string,
    contentType?: string,
    truncated = false,
    chunk = 800,
  ) {
    // Skip obviously non-text payloads
    const ct = (contentType || '').toLowerCase();
    const isTextish = /^(text\/|application\/(json|xml|x-www-form-urlencoded))/.test(ct) || !ct;
    if (!isTextish) {
      this.console?.log?.(`[Day/Night] ${phase} response: ${statusLine}; content-type=${contentType || '(unknown)'}; body not logged (non-text).`);
      return;
    }

    const total = Buffer.byteLength(body);

    this.console?.log?.(`[Day/Night] ${phase} response: ${statusLine}; content-type=${contentType || '(unknown)'}; logged body bytes=${total}${truncated ? ' (truncated)' : ''}`);

    for (let i = 0; i < body.length; i += chunk) {
      const part = body.slice(i, Math.min(i + chunk, body.length));
      this.console?.log?.(`[Day/Night] body[${i}-${Math.min(i + chunk, body.length)}]: ${part}`);
    }
  }

  private safeTime(dt: Date | undefined) {
    return dt && !Number.isNaN(dt.getTime()) ? dt : undefined;
  }

  private formatCoord(n?: number) {
    return (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(6) : '—';
  }

  private formatSigned(n: number) {
    return n >= 0 ? `+${n}` : `${n}`;
  }

  private lastSuccessText() {
    const phase = this.getString('lastPhase');
    const timestamp = this.getString('lastPhaseAt');
    const at = timestamp ? this.safeTime(new Date(timestamp)) : undefined;
    if (!phase || !at) return 'No successful action recorded yet';
    return `${phase === 'day' ? 'Day' : 'Night'} at ${this.formatLocal(at)}`;
  }

  private actionSettings(which: 'day' | 'night', label: string): Setting[] {
    const prefix = `${which}.`;
    const subgroup = `${label} Action`;
    const get = (k: string, d = '') => this.getValue(prefix + k, d);

    return [
      {
        key: prefix + 'url',
        title: `${label} URL`,
        group: GROUP,
        subgroup,
        type: 'string' as const,
        value: get('url'),
        description: `Full URL to switch to ${label.toLowerCase()} mode (e.g. http://camera/cgi-bin/…).`,
      },
      {
        key: prefix + 'method',
        title: 'Method',
        group: GROUP,
        subgroup,
        type: 'string' as const,
        value: get('method', 'GET'),
        choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        combobox: true,
        description: `HTTP method to call the ${label} URL.`,
      },
      {
        key: prefix + 'contentType',
        title: 'Content-Type',
        group: GROUP,
        subgroup,
        type: 'string' as const,
        value: get('contentType', ''),
        description: 'Only used when the method has a body (POST/PUT/PATCH/DELETE).',
      },
      {
        key: prefix + 'headers',
        title: 'Extra Headers (JSON)',
        group: GROUP,
        subgroup,
        type: 'textarea' as const,
        value: get('headers', ''),
        description: 'JSON object with additional headers, e.g. {"X-Token":"abc"}.',
      },
      {
        key: prefix + 'body',
        title: 'Body',
        group: GROUP,
        subgroup,
        type: 'textarea' as const,
        value: get('body', ''),
        description: 'Optional request body (POST/PUT/PATCH/DELETE).',
      },
    ];
  }

  /* ---------- config (merge globals unless overridden) ---------- */

  private readConfig() {
    const g = (k: string) => this.getGlobal(k);
    const gNum = (k: string): number | undefined => {
      const v = g(k); if (v == null || v === '') return undefined;
      const n = Number(v); return Number.isFinite(n) ? n : undefined;
    };
    const gBool = (k: string, d = false): boolean => {
      const v = g(k);
      if (v == null) return d;
      return v === 'true' ? true
          : v === 'false' ? false
          : d;
    };

    const overrideLoc = this.getBool('overrideLocationAndTime', false);
    const overrideRel = this.getBool('overrideReliability', false);
    const overrideOff = this.getBool('overrideOffsets', false);
    const overrideSync = this.getBool('overrideSyncOnStartup', false);

    const latitude  = overrideLoc ? this.n('latitude')  : gNum('latitude');
    const longitude = overrideLoc ? this.n('longitude') : gNum('longitude');
    const timeZone  = overrideLoc ? this.getString('timeZone') : (g('timeZone') || undefined);
    const use24h    = overrideLoc ? this.getBool('use24h', true) : gBool('use24h', true);
    const syncOnStartup = overrideSync ? this.getBool('syncOnStartup', true) : gBool('syncOnStartup', true);

    const clampOffset = (value: number | undefined) => Math.min(720, Math.max(-720, value ?? 0));
    const sunriseOffsetMins = clampOffset(
      overrideOff ? this.n('sunriseOffsetMins') : gNum('sunriseOffsetMins'),
    );
    const sunsetOffsetMins = clampOffset(
      overrideOff ? this.n('sunsetOffsetMins') : gNum('sunsetOffsetMins'),
    );

    const retries          = overrideRel ? (this.n('retries') ?? undefined)          : gNum('retries');
    const retryBaseDelayMs = overrideRel ? (this.n('retryBaseDelayMs') ?? undefined) : gNum('retryBaseDelayMs');
    const logResponses     = overrideRel ? this.getBool('logResponses', false)       : gBool('logResponses', false);

    return {
      enabled: this.getBool('enabled'),
      latitude, longitude, timeZone, use24h, syncOnStartup,
      sunriseOffsetMins, sunsetOffsetMins,

      authType: (this.getString('authType') as AuthType) || 'digest',
      username: this.getString('username'),
      password: this.getString('password'),

      day: {
        url: this.getString('day.url'),
        method: this.getString('day.method', 'GET'),
        contentType: this.getString('day.contentType'),
        headers: this.getString('day.headers'),
        body: this.getString('day.body'),
      },
      night: {
        url: this.getString('night.url'),
        method: this.getString('night.method', 'GET'),
        contentType: this.getString('night.contentType'),
        headers: this.getString('night.headers'),
        body: this.getString('night.body'),
      },

      retries: Math.round(Math.min(10, Math.max(1, retries ?? 1))),
      retryBaseDelayMs: Math.round(Math.min(60_000, Math.max(0, retryBaseDelayMs ?? 0))),
      logResponses,
      preview: this.getString('preview'),
    };
  }

  /* ---------- scheduling ---------- */

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      if (!this.released) {
        this.rescheduleAll().catch(e =>
          this.console?.error?.('[Day/Night] Heartbeat reschedule failed:', e)
        );
      }
    }, 3 * 3600_000); // every 3 hours
  }

  private stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private async rescheduleAll() {
    if (this.released) return;

    if (this.isRescheduling) {
      this.rescheduleQueued = true;
      this.console?.log?.('[Day/Night] Reschedule already in progress, will run again.');
      return;
    }

    this.isRescheduling = true;
    try {
      this.clearTimers();

      // new schedule version; stale timers will be ignored
      this.scheduleVersion++;

      const c = this.readConfig();
      const now = new Date();

      // heartbeat replaces one-shot "guard" — keep it running only when enabled
      if (c.enabled) this.startHeartbeat(); else this.stopHeartbeat();

      if (!c.enabled) {
        this.phaseAutomation.clear();
        this.cancelObsoleteAutomaticActions(undefined, true);
        this.console?.log?.('[Day/Night] Scheduling disabled');
        this.saveToStorage('previewHtml', '<div style="opacity:.7">Switching is disabled.</div>');
        return;
      }

      const jitter = Math.floor(Math.random() * 60_000);
      const nextRecalc = new Date(now.getTime() + 3600_000 + jitter);
      this.scheduleAt(nextRecalc, () => {
        sunTimesCache.clear();
        this.rescheduleAll();
      }, 'recalc');

      if (!isNum(c.latitude!) || !isNum(c.longitude!) ||
          c.latitude! < -90 || c.latitude! > 90 ||
          c.longitude! < -180 || c.longitude! > 180) {
        this.phaseAutomation.clear();
        this.cancelObsoleteAutomaticActions(undefined, true);
        this.initialSyncPending = true;
        this.console?.warn?.('[Day/Night] Invalid latitude/longitude; scheduling skipped.');
        this.saveToStorage('preview', 'Invalid latitude/longitude');
        this.saveToStorage('previewHtml', '<div style="color:#b00">Location not configured (lat/long).</div>');
        return;
      }

      const events = this.getSolarEventsAround(
        now,
        c.latitude!,
        c.longitude!,
        c.sunriseOffsetMins,
        c.sunsetOffsetMins,
      );
      const nextSunriseEvent = nextEventForPhase(events, 'day', now);
      const nextSunsetEvent = nextEventForPhase(events, 'night', now);
      const expectedPhase = expectedPhaseAt(events, now);

      if (!nextSunriseEvent || !nextSunsetEvent || !expectedPhase) {
        this.phaseAutomation.clear();
        this.cancelObsoleteAutomaticActions(undefined, true);
        this.initialSyncPending = true;
        this.console?.warn?.('[Day/Night] No usable sunrise/sunset events around this date at the configured location.');
        this.saveToStorage('preview', 'No sunrise/sunset events near this date');
        this.saveToStorage('previewHtml', '<div style="color:#b00">No sunrise/sunset events near this date at this location.</div>');
        return;
      }

      const nextSunrise = nextSunriseEvent.at;
      const nextSunset = nextSunsetEvent.at;

      this.scheduleAt(nextSunrise, () => {
        this.runScheduledPhase('day');
      });

      this.scheduleAt(nextSunset, () => {
        this.runScheduledPhase('night');
      });

      const preview = `Sunrise → Day: ${this.formatLocal(nextSunrise)} | Sunset → Night: ${this.formatLocal(nextSunset)}`;
      this.saveToStorage('preview', preview);

      const overrideLoc = this.getBool('overrideLocationAndTime', false);
      const overrideOff = this.getBool('overrideOffsets', false);
      const previewHtml = this.buildPreviewHtml(nextSunrise, nextSunset, now, c.timeZone, {
        lat: c.latitude!,
        lon: c.longitude!,
        locSource: overrideLoc ? 'camera' : 'global',
        sunriseOffset: c.sunriseOffsetMins,
        sunsetOffset: c.sunsetOffsetMins,
        offSource: overrideOff ? 'camera' : 'global',
      });
      this.saveToStorage('previewHtml', previewHtml);

      this.console?.log?.(`[Day/Night] Scheduled: ${preview}`);

      const observation = this.phaseAutomation.observeExpectedPhase(expectedPhase, now.getTime());
      this.cancelObsoleteAutomaticActions(expectedPhase, observation.phaseChanged);
      const reconciliationActive = this.reconcilePendingPhase(
        observation.reconciliation,
        expectedPhase,
      );

      if (observation.phaseChanged) {
        this.initialSyncPending = false;
        this.console?.log?.(
          `[Day/Night] Calculated phase changed from ${observation.previousExpectedPhase} to ${expectedPhase}; applying the missed transition.`,
        );
        this.runRecoverableAutomaticPhase(expectedPhase, 'Calculated').catch(() => {});
      } else if (!c.syncOnStartup) {
        this.initialSyncPending = false;
      } else if (!reconciliationActive && this.initialSyncPending) {
        this.console?.log?.(`[Day/Night] Initial phase sync: ${expectedPhase}`);
        this.requestPhaseSwitch(expectedPhase, 'automatic').then(() => {
          this.initialSyncPending = false;
        }).catch(e => {
          if (this.shouldIgnoreAutomaticError(e, expectedPhase)) return;
          this.console?.error?.(`[Day/Night] Initial ${expectedPhase} sync failed; will retry on the next schedule check:`, e?.message || e);
        });
      }
    } finally {
      this.isRescheduling = false;
      if (this.rescheduleQueued && !this.released) {
        this.rescheduleQueued = false;
        this.rescheduleAll().catch(e =>
          this.console?.error?.('[Day/Night] Reschedule (queued) failed:', e)
        );
      }
    }
  }

  private getSolarEventsAround(
    now: Date,
    latitude: number,
    longitude: number,
    sunriseOffsetMins: number,
    sunsetOffsetMins: number,
  ) {
    const days: SunTimes[] = [];

    // Include enough input days for the configured offsets and for solar
    // events whose UTC date falls next to the supplied local calendar date.
    for (const dayOffset of solarEventDayOffsets(sunriseOffsetMins, sunsetOffsetMins)) {
      const date = new Date(now);
      date.setDate(now.getDate() + dayOffset);
      const raw = getSunTimesCached(date, latitude, longitude);
      const sunrise = this.safeTime(raw.sunrise);
      const sunset = this.safeTime(raw.sunset);
      if (sunrise && sunset) days.push({ sunrise, sunset });
    }

    return buildSolarEvents(days, sunriseOffsetMins, sunsetOffsetMins);
  }

  private runScheduledPhase(phase: DayNightPhase) {
    const version = this.scheduleVersion;
    const observation = this.phaseAutomation.observeExpectedPhase(phase);
    if (observation.reconciliation.kind === 'cancelled') {
      this.console?.log?.(
        `[Day/Night] Cancelled pending ${observation.reconciliation.phase} reconciliation because the scheduled phase is now ${phase}.`,
      );
    }
    this.initialSyncPending = false;
    this.cancelObsoleteAutomaticActions(phase, observation.phaseChanged);

    this.runRecoverableAutomaticPhase(phase, 'Scheduled').finally(() => {
      if (this.released || version !== this.scheduleVersion) return;
      this.rescheduleAll().catch(e =>
        this.console?.error?.('[Day/Night] Post-action reschedule failed:', e)
      );
    });
  }

  private scheduleAt(when: Date, fn: () => void, label: 'action' | 'recalc' = 'action') {
    const raw = when.getTime() - Date.now();
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, raw));
    if (delay > 0) {
      const myVersion = this.scheduleVersion;
      const what = label === 'recalc' ? 'recompute' : 'action';
      const timer = setTimeout(() => {
        if (this.released || myVersion !== this.scheduleVersion)
          return; // ignore stale timers
        try {
          fn();
        } catch (e: any) {
          this.console?.error?.(`[Day/Night] Scheduled ${what} threw:`, e?.message || e);
        }
      }, delay);
      this.timers.push(timer);
      const hours = Math.floor(delay / 3_600_000);
      const minutes = Math.floor((delay % 3_600_000) / 60_000);
      this.console?.log?.(`[Day/Night] Scheduled ${what} in ${hours}h ${minutes}m at ${this.formatLocal(when)}`);
    }
  }

  private requestPhaseSwitch(
    phase: DayNightPhase,
    source: PhaseRequestContext['source'] = 'manual',
  ): Promise<void> {
    if (this.released) return Promise.reject(new Error('Mixin has been released'));
    return this.phaseSwitchQueue.request(phase, {
      source,
      scheduleGeneration: source === 'automatic' ? this.automaticGeneration : undefined,
      expectedPhase: source === 'automatic' ? phase : undefined,
    });
  }

  private reconcilePendingPhase(
    decision: ReconciliationDecision,
    expectedPhase: DayNightPhase,
  ) {
    if (decision.kind === 'cancelled') {
      this.console?.log?.(`[Day/Night] Cancelled pending ${decision.phase} reconciliation because the expected phase is now ${expectedPhase}.`);
      return false;
    }

    if (decision.kind === 'retry') {
      this.console?.log?.(`[Day/Night] Retrying pending ${decision.phase} reconciliation.`);
      this.requestPhaseSwitch(decision.phase, 'automatic').catch(error => {
        if (this.shouldIgnoreAutomaticError(error, decision.phase)) return;
        this.phaseAutomation.markAttemptFailure(decision.phase);
        this.console?.error?.(`[Day/Night] ${decision.phase} reconciliation failed; another hourly attempt will be made:`, error?.message || error);
      });
      return true;
    }

    return decision.kind === 'waiting';
  }

  private runRecoverableAutomaticPhase(phase: DayNightPhase, label: string) {
    return this.requestPhaseSwitch(phase, 'automatic').catch(error => {
      if (this.shouldIgnoreAutomaticError(error, phase)) return;

      this.console?.error?.(`[Day/Night] ${label} ${phase} switch failed:`, error?.message || error);
      const accepted = this.phaseAutomation.markScheduledFailure(phase);
      if (accepted !== undefined) {
        this.console?.warn?.(`[Day/Night] ${phase} reconciliation is pending and will retry during an hourly schedule check.`);
      }
    });
  }

  private shouldIgnoreAutomaticError(error: unknown, phase: DayNightPhase) {
    return error instanceof PhaseQueueCancellationError
      || this.released
      || this.getValue('enabled') !== 'true'
      || !this.phaseAutomation.isExpectedPhase(phase);
  }

  private cancelObsoleteAutomaticActions(
    expectedPhase?: DayNightPhase,
    invalidateGeneration = false,
  ) {
    const shouldCancel = (phase: DayNightPhase) => (
      invalidateGeneration || expectedPhase === undefined || phase !== expectedPhase
    );
    if (invalidateGeneration) this.automaticGeneration++;
    const cancellation = new PhaseQueueCancellationError(
      expectedPhase
        ? `Automatic phase request is obsolete; expected phase is ${expectedPhase}`
        : 'Automatic phase request cancelled because switching is unavailable',
    );
    const cancelled = this.phaseSwitchQueue.cancelQueued(request => (
      request.context?.source === 'automatic' && shouldCancel(request.phase)
    ), cancellation);

    let aborted = false;
    if (this.activeAutomaticAction && shouldCancel(this.activeAutomaticAction.phase)) {
      this.activeAutomaticAction.controller.abort();
      aborted = true;
    }

    if (cancelled || aborted) {
      this.console?.log?.(
        `[Day/Night] Cancelled ${cancelled} queued automatic action(s)${aborted ? ' and aborted the active automatic action' : ''}.`,
      );
    }
  }

  private async switchPhase(phase: DayNightPhase, context?: PhaseRequestContext) {
    const automatic = context?.source === 'automatic';
    if (automatic && (
      this.getValue('enabled') !== 'true'
      || !this.phaseAutomation.isExpectedPhase(phase)
    )) {
      throw new PhaseQueueCancellationError(`Automatic ${phase} action is no longer expected`);
    }

    const automaticController = automatic ? new AbortController() : undefined;
    if (automaticController) {
      this.activeAutomaticAction = { phase, controller: automaticController };
    }

    try {
      this.console?.log?.(`[Day/Night] Switching to ${phase} mode...`);
      await this.invokeAction(phase, automaticController?.signal);
      this.saveToStorage('lastPhase', phase);
      this.saveToStorage('lastPhaseAt', new Date().toISOString());
      this.console?.log?.(`[Day/Night] Successfully switched to ${phase} mode`);
      if (this.phaseAutomation.markSuccess(phase)) {
        this.console?.log?.(`[Day/Night] ${phase} reconciliation succeeded.`);
      }
    } catch (e: any) {
      if (automaticController?.signal.aborted) {
        throw new PhaseQueueCancellationError(`Automatic ${phase} action was cancelled`);
      }
      if (!automatic || !this.shouldIgnoreAutomaticError(e, phase)) {
        this.console?.error?.(`[Day/Night] Failed to switch to ${phase} mode:`, e?.message || e);
      }
      throw e;
    } finally {
      if (automaticController && this.activeAutomaticAction?.controller === automaticController) {
        this.activeAutomaticAction = undefined;
      }
    }
  }

  private normaliseAndMergeHeaders(target: Record<string, string>, json?: string) {
    if (!json) return;
    try {
      const extra = JSON.parse(json);
      if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        for (const [k, v] of Object.entries(extra)) {
          const key = String(k).trim();
          if (!key || v == null) continue;

          if (typeof v === 'string') {
            target[key] = v;
          } else if (typeof v === 'number' || typeof v === 'boolean') {
            target[key] = String(v);
          } else {
            // objects/arrays -> JSON string
            target[key] = JSON.stringify(v);
          }
        }
      } else {
        this.console?.warn?.('[Day/Night] Headers JSON must be an object.');
      }
    } catch {
      this.console?.warn?.('[Day/Night] Headers invalid JSON; ignoring.');
    }
  }

  private async discardResponseBody(response: Response | import('node-fetch').Response) {
    const body: any = response.body;
    if (!body) return;
    try {
      if (typeof body.cancel === 'function') await body.cancel();
      else if (typeof body.destroy === 'function') body.destroy();
    } catch {}
  }

  private async readResponseBodyLimited(
    response: Response | import('node-fetch').Response,
    limit = DayNightMixin.MAX_LOG_BYTES,
  ): Promise<{ text: string; truncated: boolean }> {
    const body: any = response.body;
    if (!body) return { text: '', truncated: false };

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;

    for await (const rawChunk of body as AsyncIterable<Uint8Array | string>) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const remaining = limit - bytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        bytes = limit;
        truncated = true;
        await this.discardResponseBody(response);
        break;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    }

    return { text: Buffer.concat(chunks, bytes).toString('utf8'), truncated };
  }

  private async handleResponse(
    phase: DayNightPhase,
    response: Response | import('node-fetch').Response,
    logResponses: boolean,
    signal?: AbortSignal,
  ) {
    const statusLine = `HTTP ${response.status} ${response.statusText}`;
    const contentType = response.headers.get('content-type') || undefined;
    const isTextish = /^(text\/|application\/(json|xml|x-www-form-urlencoded))/.test((contentType || '').toLowerCase()) || !contentType;

    try {
      if (logResponses && isTextish) {
        const body = await this.readResponseBodyLimited(response);
        this.logBodyChunks(phase, statusLine, body.text, contentType, body.truncated);
      } else {
        if (logResponses) this.logBodyChunks(phase, statusLine, '', contentType);
        await this.discardResponseBody(response);
      }
    } catch (error: any) {
      // Response logging is diagnostic. Once a successful status has arrived,
      // a malformed, truncated, or timed-out body must not repeat the action.
      if (!signal?.aborted) {
        this.console?.warn?.(
          `[Day/Night] ${phase} response body could not be logged:`,
          error?.message || error,
        );
      }
      await this.discardResponseBody(response);
    }

    if (!response.ok) throw new Error(statusLine);
  }

  private async invokeAction(phase: DayNightPhase, actionSignal?: AbortSignal) {
    const c = this.readConfig();
    const action = (phase === 'day' ? c.day : c.night) || {};

    if (!action.url) throw new Error(`${phase} URL not configured`);

    const method = (action.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const bodyAllowed = this.allowBody(method);

    if (action.contentType && bodyAllowed) headers['Content-Type'] = action.contentType;
    this.normaliseAndMergeHeaders(headers, action.headers);

    const linkedAbort = combineAbortSignals([
      this.lifecycleAbort.signal,
      ...(actionSignal ? [actionSignal] : []),
    ]);

    try {
      await withRetries(async () => {
        try {
          await sendCameraRequest({
            url: action.url!,
            method,
            headers,
            body: bodyAllowed && action.body ? action.body : undefined,
            authType: c.authType,
            username: c.username,
            password: c.password,
            lifecycleSignal: linkedAbort.signal,
          }, undefined, async (response, signal) => {
            await this.handleResponse(phase, response, c.logResponses, signal);
          });
        } catch (error) {
          if (error instanceof CameraResponseConsumerError) {
            if (error.response.ok && !linkedAbort.signal.aborted) {
              this.console?.warn?.(
                `[Day/Night] ${phase} response body processing ended after a successful HTTP status:`,
                (error.cause as any)?.message || error.cause,
              );
              this.discardResponseBody(error.response).catch(() => {});
              return;
            }
            if (!error.response.ok) {
              throw new Error(
                `HTTP ${error.response.status} ${error.response.statusText}`,
                { cause: error.cause },
              );
            }
            throw error.cause;
          }
          throw error;
        }
      }, {
        attempts: c.retries,
        baseDelayMs: c.retryBaseDelayMs,
        signal: linkedAbort.signal,
        onRetry: (attempt, totalAttempts, delayMs) => {
          this.console?.log?.(`[Day/Night] Retry ${attempt}/${totalAttempts} after ${delayMs}ms delay`);
        },
      });
    } finally {
      linkedAbort.dispose();
    }
  }

  private safeTimeZone(tz?: string): string | undefined {
    if (!tz) return undefined;
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date());
      return tz;
    } catch {
      this.console?.warn?.(`[Day/Night] Invalid time zone "${tz}", falling back to server time.`);
      return undefined;
    }
  }

  private formatLocal(dt: Date): string {
    const c = this.readConfig();
    const tz = this.safeTimeZone(c.timeZone);
    return dt.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: c.use24h ? false : undefined,
      timeZone: tz,
      timeZoneName: 'short',
    });
  }

  private formatRelativeShort(when: Date, now = new Date()) {
    let ms = when.getTime() - now.getTime();
    const past = ms < 0;
    ms = Math.abs(ms);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const parts: string[] = [];
    if (h) parts.push(`${h}h`);
    if (m || !h) parts.push(`${m}m`);
    return past ? `${parts.join(' ')} ago` : `in ${parts.join(' ')}`;
  }

  private buildPreviewHtml(
    nextSunrise: Date,
    nextSunset: Date,
    now: Date,
    tzLabel: string | undefined,
    meta: {
      lat: number;
      lon: number;
      locSource: 'camera' | 'global';
      sunriseOffset: number;
      sunsetOffset: number;
      offSource: 'camera' | 'global';
    }
  ) {
    const nextIsSunrise = nextSunrise.getTime() < nextSunset.getTime();
    const nextWhen  = nextIsSunrise ? nextSunrise : nextSunset;
    const nextPhase = nextIsSunrise ? 'Day' : 'Night';
    const tz = tzLabel ? ` (${tzLabel})` : '';
    const lastSuccess = this.lastSuccessText();
    const ICON_GAP_PX = 8;

    const icoHeader = (e: string) =>
      `<span style="display:inline-block;width:1.6em;text-align:center;line-height:1">${e}</span>`;
    const icoCell = (e: string) =>
      `<span style="display:inline-block;width:1.6em;text-align:center;line-height:1">${e}</span>`;

    const headCells = (emoji: string, label: string) =>
      `<td style="padding:6px ${8 + ICON_GAP_PX}px 6px 8px;vertical-align:middle;width:2em">${icoCell(emoji)}</td>
      <td style="padding:6px 6px;vertical-align:middle;opacity:.9;white-space:nowrap">${label}</td>`;
    const valCell = (html: string) =>
      `<td style="padding:6px 0;vertical-align:middle">${html}</td>`;

    const rows = `
      <tr>${headCells('☀️', 'Sunrise → Day')}${valCell(`<code>${this.formatLocal(nextSunrise)}</code>${tz}`)}</tr>
      <tr>${headCells('🌙', 'Sunset → Night')}${valCell(`<code>${this.formatLocal(nextSunset)}</code>${tz}`)}</tr>
      <tr><td colspan="3" style="padding:0;border-top:1px solid rgba(0,0,0,.08)"></td></tr>
      <tr>${headCells('📍', 'Location')}${valCell(`<code>${this.formatCoord(meta.lat)}, ${this.formatCoord(meta.lon)}</code> <span style="opacity:.7">(${meta.locSource})</span>`)}</tr>
      <tr>${headCells('⏱', 'Offsets')}${valCell(`<code>sunrise ${this.formatSigned(meta.sunriseOffset)} min, sunset ${this.formatSigned(meta.sunsetOffset)} min</code> <span style="opacity:.7">(${meta.offSource})</span>`)}</tr>
    `;

    return `<div>
      <div style="margin:6px 0 10px">
        <strong>Next switch:</strong> ${icoHeader(nextIsSunrise ? '☀️' : '🌙')} ${nextPhase}
        at <b>${this.formatLocal(nextWhen)}</b>${tz}
        <span style="opacity:.7">(${this.formatRelativeShort(nextWhen, now)})</span>
      </div>
      <div style="margin:0 0 10px">
        <strong>Last successful action:</strong> ${lastSuccess}
      </div>
      <table style="border-collapse:collapse;margin:0;table-layout:fixed;width:100%">
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private async previewSchedule() {
    const c = this.readConfig();

    if (!c.enabled) {
      this.saveToStorage('preview', 'Switching is disabled');
      this.saveToStorage('previewHtml', '<div style="opacity:.7">Switching is disabled.</div>');
      return;
    }

    if (!isNum(c.latitude!) || !isNum(c.longitude!)) {
      this.saveToStorage('preview', 'Latitude/Longitude not set');
      this.saveToStorage('previewHtml', '<div style="color:#b00">Location not configured (lat/long).</div>');
      return;
    }

    const now = new Date();

    const events = this.getSolarEventsAround(
      now,
      c.latitude!,
      c.longitude!,
      c.sunriseOffsetMins,
      c.sunsetOffsetMins,
    );
    const nextSunrise = nextEventForPhase(events, 'day', now)?.at;
    const nextSunset = nextEventForPhase(events, 'night', now)?.at;
    if (!nextSunrise || !nextSunset) {
      this.saveToStorage('preview', 'No sunrise/sunset events near this date');
      this.saveToStorage('previewHtml', '<div style="color:#b00">No sunrise/sunset events near this date at this location.</div>');
      return;
    }

    const text = `Sunrise → Day: ${this.formatLocal(nextSunrise)} | Sunset → Night: ${this.formatLocal(nextSunset)}`;
    this.saveToStorage('preview', text);

    const overrideLoc = this.getBool('overrideLocationAndTime', false);
    const overrideOff = this.getBool('overrideOffsets', false);
    const html = this.buildPreviewHtml(nextSunrise, nextSunset, now, c.timeZone, {
      lat: c.latitude!,
      lon: c.longitude!,
      locSource: overrideLoc ? 'camera' : 'global',
      sunriseOffset: c.sunriseOffsetMins,
      sunsetOffset: c.sunsetOffsetMins,
      offSource: overrideOff ? 'camera' : 'global',
    });
    this.saveToStorage('previewHtml', html);
  }

  async release() {
    this.released = true;
    this.lifecycleAbort.abort();
    const releaseError = new Error('Mixin released before the queued phase switch could run');
    this.phaseSwitchQueue.release(releaseError);
    this.clearTimers();
    this.stopHeartbeat();
    if (this.globalsDebounce) {
      clearTimeout(this.globalsDebounce);
      this.globalsDebounce = undefined;
    }
    this.console?.log?.('[Day/Night] Mixin released, timers/heartbeat/debounces cleared');
  }
}

/* ---------------- Provider (globals) ---------------- */

export default class DayNightProvider extends ScryptedDeviceBase implements MixinProvider {
  constructor(nativeId?: string) {
    super(nativeId);
  }

  async getSettings(): Promise<Setting[]> {
    const g = this.storage;
    const get = (k: string, d?: string) => g.getItem(k) ?? d;

    return [
      { key: 'h_loc', type: 'html' as const, readonly: true,
        value: '<h3 style="margin:8px 0">Location &amp; Time</h3>' },

      {
        key: 'global.latitude',
        title: 'Latitude',
        type: 'number' as const,
        value: get('global.latitude', ''),
        placeholder: '51.507351',
        description:
          'Decimal degrees. Example: 51.507351 (central London). 6 decimal places is plenty (~11 cm). Valid range −90 to 90.',
      },
      {
        key: 'global.longitude',
        title: 'Longitude',
        type: 'number' as const,
        value: get('global.longitude', ''),
        placeholder: '-0.127758',
        description:
          'Decimal degrees. Example: −0.127758 (central London). 6 decimal places is plenty. Valid range −180 to 180.',
      },
      {
        key: 'global.timeZone',
        title: 'Time zone (optional)',
        type: 'string' as const,
        value: get('global.timeZone', ''),
        placeholder: 'Europe/London',
        description:
          'IANA time zone. Leave blank to use the server’s time zone.',
      },
      {
        key: 'global.use24h',
        title: 'Use 24-hour time',
        type: 'boolean' as const,
        value: get('global.use24h', 'true') === 'true',
      },
      {
        key: 'global.syncOnStartup',
        title: 'Sync phase on startup',
        type: 'boolean' as const,
        value: get('global.syncOnStartup', 'true') === 'true',
        description: 'Send the expected Day/Night action once when each camera mixin starts or switching is enabled.',
      },

      { key: 'global.sunriseOffsetMins',
        title: 'Sunrise offset (mins, default)',
        type: 'number' as const,
        value: get('global.sunriseOffsetMins', '0'),
        placeholder: '0',
        description: 'Default for all cameras. Positive = after sunrise; negative = before.',
      },
      { key: 'global.sunsetOffsetMins',
        title: 'Sunset offset (mins, default)',
        type: 'number' as const,
        value: get('global.sunsetOffsetMins', '0'),
        placeholder: '0',
        description: 'Default for all cameras. Positive = after sunset; negative = before.',
      },

      { key: 'h_rel', type: 'html' as const, readonly: true,
        value: '<h3 style="margin:16px 0 8px">Reliability defaults</h3>' },

      {
        key: 'global.retries',
        title: 'HTTP total attempts (default)',
        type: 'number' as const,
        value: get('global.retries', '1'),
        placeholder: '1',
        description: 'Total tries per request (1–10). Set 1 to disable retries.',
      },
      {
        key: 'global.retryBaseDelayMs',
        title: 'Retry base delay (ms, default)',
        type: 'number' as const,
        value: get('global.retryBaseDelayMs', '0'),
        placeholder: '500',
        description: 'Base delay for exponential back-off (0–60000 ms) with jitter.',
      },
      {
        key: 'global.logResponses',
        title: 'Log HTTP responses (default)',
        type: 'boolean' as const,
        value: get('global.logResponses', 'false') === 'true',
        description: 'Logs status and up to ~64 KB of response body.',
      },
    ];
  }

  async putSetting(key: string, value: SettingValue) {
    if (!key.startsWith('global.')) return;

    value = normaliseSetting(key, value);

    const v = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? '');
    this.storage.setItem(key, v);

    for (const m of mixinsById.values()) {
      try { m.notifyGlobalsChanged(); } catch {}
    }
  }

  async canMixin(type: string, interfaces: string[]): Promise<string[] | null> {
    const isCamera = type === ScryptedDeviceType.Camera || interfaces?.includes(ScryptedInterface.VideoCamera);
    return isCamera ? [ScryptedInterface.Settings] : null;
  }

  async getMixin(mixinDevice: any,
                 mixinDeviceInterfaces: ScryptedInterface[],
                 mixinDeviceState: WritableDeviceState) {
    // Resolve a stable key
    let deviceId: string | undefined;
    try {
      deviceId = mixinDeviceState?.id;
      if (!deviceId && typeof mixinDevice?.id === 'function') deviceId = await mixinDevice.id();
      if (!deviceId && typeof mixinDevice?.id === 'string') deviceId = mixinDevice.id;
      if (!deviceId && typeof mixinDevice?.nativeId === 'function') deviceId = await mixinDevice.nativeId();
      if (!deviceId && typeof mixinDevice?.nativeId === 'string') deviceId = mixinDevice.nativeId;
    } catch (e) {
      this.console?.error?.('[Day/Night] Error getting device ID:', e);
    }
    if (!deviceId) throw new Error('[Day/Night] No device ID available');
    const key = String(deviceId);

    // If one exists, release it
    const prev = mixinsById.get(key);
    if (prev) {
      this.console?.debug?.(`[Day/Night] Replacing existing mixin for ${key}`);
      try { await prev.release(); } catch (e) {
        this.console?.warn?.('[Day/Night] Error releasing previous mixin:', (e as any)?.message ?? e);
      }
      mixinsById.delete(key);
      // remove reverse mapping for the old device handle
      const oldHandle = prev.getDeviceHandle?.();
      if (oldHandle) mixinsByDevice.delete(oldHandle);
      await new Promise(r => setTimeout(r, 0));
    }

    // Create new
    const mixin = new DayNightMixin({
      groupKey: GROUP_KEY,
      group: GROUP,
      mixinDevice,
      mixinDeviceInterfaces,
      mixinDeviceState,
      mixinProviderNativeId: this.nativeId!,
      getGlobal: (k: string) => this.storage.getItem(`global.${k}`) ?? undefined,
    });

    mixinsById.set(key, mixin);
    mixinsByDevice.set(mixinDevice, mixin); // new

    return mixin;
  }

  async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    const inst = mixinsByDevice.get(mixinDevice) ?? mixinsById.get(String(id));
    if (!inst) {
      return;
    }
    mixinsByDevice.delete(mixinDevice);
    for (const [key, candidate] of mixinsById) {
      if (candidate === inst) mixinsById.delete(key);
    }
    try { await inst.release(); } catch (e) {
      this.console?.warn?.('[Day/Night] Error during mixin release:', (e as any)?.message ?? e);
    }
    this.console?.log?.(`[Day/Night] Released mixin for device ${id}`);
  }


  async release() {
    this.console?.log?.('[Day/Night] Provider releasing, cleaning up all mixins...');
    
    const releasePromises: Promise<void>[] = [];
    for (const [key, mixin] of mixinsById.entries()) {
      releasePromises.push(
        mixin.release().catch(e => {
          this.console?.warn?.(`[Day/Night] Error releasing mixin ${key}:`, e?.message ?? e);
        })
      );
    }
    
    await Promise.all(releasePromises);
    mixinsById.clear();
    mixinsByDevice = new WeakMap();
    
    this.console?.log?.('[Day/Night] Provider released, all mixins cleaned up');
  }
}
