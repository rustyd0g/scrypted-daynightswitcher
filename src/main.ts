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
import DigestClient from 'digest-fetch';

type AuthType = 'digest' | 'basic' | 'none';

const GROUP = 'Day/Night Switcher';
const GROUP_KEY = 'dayNightSwitcher';
const MAX_DELAY_MS = 24 * 3600_000;

const mixinsById = new Map<string, DayNightMixin>();

function mixinKey(mixinDevice: any, idFromFramework?: string) {
  const key = idFromFramework ?? mixinDevice?.id ?? mixinDevice?.nativeId;
  if (!key) {
    throw new Error('[Day/Night] Could not determine a stable mixin key (no id/nativeId)');
  }
  return String(key);
}

function isNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
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
  } as Record<string, string>)[key] ?? key;

  switch (k) {
    case 'latitude':
      return isNumLike(value) ? String(clamp(asNumber(value), -90, 90)) : value;

    case 'longitude':
      return isNumLike(value) ? String(clamp(asNumber(value), -180, 180)) : value;

    case 'sunriseOffsetMins':
    case 'sunsetOffsetMins':
      return isNumLike(value) ? String(clamp(asNumber(value), -720, 720)) : value;

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
  const key = sunKey(lat, lon, date);
  const hit = sunTimesCache.get(key);
  if (hit) {
    // LRU bump
    sunTimesCache.delete(key);
    sunTimesCache.set(key, hit);
    return { sunrise: new Date(hit.sunrise), sunset: new Date(hit.sunset) };
  }

  const t = SunCalc.getTimes(date, lat, lon);
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

  constructor(options: DayNightMixinOptions) {
    super(options);
    this.getGlobal = options.getGlobal;
    this.loadSettingsFromStorage();
    this.initializeScheduling();
  }

  private globalsDebounce?: NodeJS.Timeout;

  notifyGlobalsChanged() {
    this.console?.log?.('[Day/Night] Globals changed → reschedule');
    clearTimeout(this.globalsDebounce);
    this.globalsDebounce = setTimeout(() => {
      this.rescheduleAll().catch(e => this.console?.error?.('Reschedule after globals change failed:', e));
    }, 300); // tweak if you like
  }

  private loadSettingsFromStorage() {
    const keys = [
      'enabled',
      'overrideLocationAndTime', 'overrideReliability', 'overrideOffsets',
      'sunriseOffsetMins', 'sunsetOffsetMins',
      'latitude', 'longitude', 'timeZone', 'use24h', 'syncOnStartup',
      'retries', 'retryBaseDelayMs', 'logResponses',
      'authType', 'username', 'password',
      'day.url', 'day.method', 'day.contentType', 'day.headers', 'day.body',
      'night.url', 'night.method', 'night.contentType', 'night.headers', 'night.body',
      'preview', 'previewHtml',
      'lastPhase',
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

    const g = (k: string) => this.getGlobal?.(k);
    const glat = g?.('latitude') ?? '';
    const glon = g?.('longitude') ?? '';
    const gtz = g?.('timeZone') ?? '';
    const g24h = (g?.('use24h') ?? 'true') === 'true';
    const gSunriseOff = g?.('sunriseOffsetMins') ?? '0';
    const gSunsetOff = g?.('sunsetOffsetMins') ?? '0';

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
        {
          key: 'syncOnStartup',
          title: 'Sync phase on startup',
          group: GROUP,
          subgroup: 'General',
          type: 'boolean' as const,
          value: this.getValue('syncOnStartup', 'true') === 'true',
          description: 'Send Day/Night on startup if the current state does not match the expected phase.',
        },
      );
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
          description: 'Total tries including the first attempt. Set 1 to disable retries.',
        },
        {
          key: 'retryBaseDelayMs',
          title: 'Retry base delay (ms)',
          group: GROUP,
          subgroup: 'Reliability & Logging',
          type: 'number' as const,
          value: this.getValue('retryBaseDelayMs', ''),
          description: 'Base delay for exponential back-off; jitter is added.',
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

  async putMixinSetting(key: string, value: SettingValue) {
    this.console?.log?.(`[Day/Night] Setting ${key} = ${value} (type: ${typeof value})`);

    if (key === '__btn_preview') { await this.previewSchedule(); return; }
    if (key === '__btn_day') { if (this.getValue('enabled') !== 'true') this.console?.log?.('[Day/Night] Manual Day with switching disabled.'); await this.switchPhase('day'); return; }
    if (key === '__btn_night') { if (this.getValue('enabled') !== 'true') this.console?.log?.('[Day/Night] Manual Night with switching disabled.'); await this.switchPhase('night'); return; }

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

    if ([
      'enabled',
      'overrideLocationAndTime', 'overrideReliability', 'overrideOffsets',
      'latitude', 'longitude', 'timeZone', 'use24h', 'syncOnStartup',
      'sunriseOffsetMins', 'sunsetOffsetMins',
      'retries', 'retryBaseDelayMs', 'logResponses',
    ].includes(key)) {
      const isEnabling = (key === 'enabled' && (value === true || value === 'true'));
      const isEnabled = this.getValue('enabled') === 'true';
      if (isEnabling || (key !== 'enabled' && isEnabled)) {
        this.console?.log?.('[Day/Night] Rescheduling due to setting change');
        this.rescheduleAll().catch(e => this.console?.error?.('[Day/Night] Failed to reschedule:', e));
      } else if (key === 'enabled' && (value === false || value === 'false')) {
        this.console?.log?.('[Day/Night] Disabling schedules');
        this.clearTimers();
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
    phase: 'day' | 'night',
    statusLine: string,
    body: string,
    contentType?: string,
    chunk = 800,
  ) {
    // Skip obviously non-text payloads
    const ct = (contentType || '').toLowerCase();
    const isTextish = /^(text\/|application\/(json|xml|x-www-form-urlencoded))/.test(ct) || !ct;
    if (!isTextish) {
      this.console?.log?.(`[Day/Night] ${phase} response: ${statusLine}; content-type=${contentType || '(unknown)'}; body not logged (non-text).`);
      return;
    }

    let logged = 0;
    const total = body.length;
    const cap = Math.min(total, DayNightMixin.MAX_LOG_BYTES);

    this.console?.log?.(`[Day/Night] ${phase} response: ${statusLine}; content-type=${contentType || '(unknown)'}; body length=${total}${total > cap ? ` (logging first ${cap} bytes)` : ''}`);

    for (let i = 0; i < cap; i += chunk) {
      const part = body.slice(i, Math.min(i + chunk, cap));
      this.console?.log?.(`[Day/Night] body[${i}-${Math.min(i + chunk, cap)}]: ${part}`);
      logged += part.length;
    }

    if (cap < total) {
      this.console?.log?.(`[Day/Night] body truncated: logged ${logged}/${total} bytes`);
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

    const latitude = overrideLoc ? this.n('latitude') : gNum('latitude');
    const longitude = overrideLoc ? this.n('longitude') : gNum('longitude');
    const timeZone = overrideLoc ? this.getString('timeZone') : (g('timeZone') || undefined);
    const use24h = overrideLoc ? this.getBool('use24h', true) : gBool('use24h', true);
    const syncOnStartup = overrideLoc ? this.getBool('syncOnStartup', true) : gBool('syncOnStartup', true);

    const sunriseOffsetMins = (overrideOff ? this.n('sunriseOffsetMins') : gNum('sunriseOffsetMins')) ?? 0;
    const sunsetOffsetMins = (overrideOff ? this.n('sunsetOffsetMins') : gNum('sunsetOffsetMins')) ?? 0;

    const retries = overrideRel ? (this.n('retries') ?? undefined) : gNum('retries');
    const retryBaseDelayMs = overrideRel ? (this.n('retryBaseDelayMs') ?? undefined) : gNum('retryBaseDelayMs');
    const logResponses = overrideRel ? this.getBool('logResponses', false) : gBool('logResponses', false);

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

      retries: retries ?? 1,
      retryBaseDelayMs: retryBaseDelayMs ?? 0,
      logResponses,
      preview: this.getString('preview'),
    };
  }

  /* ---------- scheduling ---------- */

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async rescheduleAll() {
    this.clearTimers();
    const c = this.readConfig();

    const now = new Date();

    const jitter = Math.floor(Math.random() * 60_000);
    const nextRecalc = new Date(now.getTime() + 3600_000 + jitter);
    this.scheduleAt(nextRecalc, () => {
      sunTimesCache.clear();
      this.rescheduleAll();
    }, 'recalc');

    const guard = !c.enabled
      ? undefined
      : setTimeout(() => this.rescheduleAll(), 6 * 3600_000);
    if (guard) this.timers.push(guard);

    if (!c.enabled) {
      this.console?.log?.('[Day/Night] Scheduling disabled');
      this.saveToStorage('previewHtml', '<div style="opacity:.7">Switching is disabled.</div>');
      return;
    }

    if (!isNum(c.latitude!) || !isNum(c.longitude!) ||
      c.latitude! < -90 || c.latitude! > 90 ||
      c.longitude! < -180 || c.longitude! > 180) {
      this.console?.warn?.('[Day/Night] Invalid latitude/longitude; scheduling skipped.');
      this.saveToStorage('preview', 'Invalid latitude/longitude');
      this.saveToStorage('previewHtml', '<div style="color:#b00">Location not configured (lat/long).</div>');
      return;
    }

    const todayTimesRaw = getSunTimesCached(now, c.latitude!, c.longitude!);
    const sunriseTodayRaw = this.safeTime(todayTimesRaw.sunrise);
    const sunsetTodayRaw = this.safeTime(todayTimesRaw.sunset);

    if (!sunriseTodayRaw || !sunsetTodayRaw) {
      this.console?.warn?.('[Day/Night] No sunrise/sunset for this date at the configured location.');
      this.saveToStorage('preview', 'No sunrise/sunset today at this location');
      this.saveToStorage('previewHtml', '<div style="color:#b00">No sunrise/sunset at this location today.</div>');
      return;
    }

    const todaySunrise = this.applyOffset(sunriseTodayRaw, c.sunriseOffsetMins);
    const todaySunset = this.applyOffset(sunsetTodayRaw, c.sunsetOffsetMins);

    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowTimesRaw = getSunTimesCached(tomorrow, c.latitude!, c.longitude!);
    const sunriseTomorrowRaw = this.safeTime(tomorrowTimesRaw.sunrise);
    const sunsetTomorrowRaw = this.safeTime(tomorrowTimesRaw.sunset);

    const nextSunrise = (todaySunrise.getTime() > now.getTime() ? todaySunrise :
      (sunriseTomorrowRaw ? this.applyOffset(sunriseTomorrowRaw, c.sunriseOffsetMins) : todaySunrise));
    const nextSunset = (todaySunset.getTime() > now.getTime() ? todaySunset :
      (sunsetTomorrowRaw ? this.applyOffset(sunsetTomorrowRaw, c.sunsetOffsetMins) : todaySunset));

    this.scheduleAt(nextSunrise, () => {
      this.switchPhase('day');
      const t = setTimeout(() => this.rescheduleAll(), 60_000);
      this.timers.push(t);
    });

    this.scheduleAt(nextSunset, () => {
      this.switchPhase('night');
      const t = setTimeout(() => this.rescheduleAll(), 60_000);
      this.timers.push(t);
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

    if (c.syncOnStartup) {
      this.checkCurrentPhase(now, sunriseTodayRaw, sunsetTodayRaw, c.sunriseOffsetMins, c.sunsetOffsetMins);
    }
  }

  private checkCurrentPhase(now: Date, sunriseRaw: Date, sunsetRaw: Date, sunriseOffset: number, sunsetOffset: number) {
    const actualSunrise = new Date(sunriseRaw.getTime() + (sunriseOffset || 0) * 60000);
    const actualSunset = new Date(sunsetRaw.getTime() + (sunsetOffset || 0) * 60000);
    const currentTime = now.getTime();

    const expectedPhase: 'day' | 'night' =
      (currentTime >= actualSunrise.getTime() && currentTime < actualSunset.getTime()) ? 'day' : 'night';

    const lastPhase = this.getValue('lastPhase');

    this.console?.log?.(`[Day/Night] Phase check at ${this.formatLocal(now)}:`);
    this.console?.log?.(`  - Sunrise (raw): ${this.formatLocal(sunriseRaw)}  | offset: ${sunriseOffset} min  → actual: ${this.formatLocal(actualSunrise)}`);
    this.console?.log?.(`  - Sunset  (raw): ${this.formatLocal(sunsetRaw)}   | offset: ${sunsetOffset} min  → actual: ${this.formatLocal(actualSunset)}`);
    this.console?.log?.(`  - Expected phase: ${expectedPhase}`);
    this.console?.log?.(`  - Last phase: ${lastPhase || 'unknown'}`);

    if (lastPhase !== expectedPhase) {
      this.console?.log?.(`[Day/Night] Switching to ${expectedPhase} mode now`);
      this.switchPhase(expectedPhase).catch(e => {
        this.console?.error?.(`[Day/Night] Failed to switch to ${expectedPhase}:`, e);
      });
    } else {
      this.console?.log?.(`[Day/Night] Already in ${expectedPhase} mode`);
    }
  }

  private applyOffset(dt: Date, mins?: number) {
    const offsetMs = (mins || 0) * 60000;
    return new Date(dt.getTime() + offsetMs);
  }

  private scheduleAt(when: Date, fn: () => void, label: 'action' | 'recalc' = 'action') {
    const raw = when.getTime() - Date.now();
    const delay = Math.min(MAX_DELAY_MS, Math.max(0, raw));
    if (delay > 0) {
      const timer = setTimeout(fn, delay);
      this.timers.push(timer);
      const hours = Math.floor(delay / 3_600_000);
      const minutes = Math.floor((delay % 3_600_000) / 60_000);
      const what = label === 'recalc' ? 'recompute' : 'action';
      this.console?.log?.(`[Day/Night] Scheduled ${what} in ${hours}h ${minutes}m at ${this.formatLocal(when)}`);
    }
  }

  private async switchPhase(phase: 'day' | 'night') {
    try {
      this.console?.log?.(`[Day/Night] Switching to ${phase} mode...`);
      await this.invokeAction(phase);
      this.saveToStorage('lastPhase', phase);
      this.console?.log?.(`[Day/Night] Successfully switched to ${phase} mode`);
    } catch (e: any) {
      this.console?.error?.(`[Day/Night] Failed to switch to ${phase} mode:`, e?.message || e);
    }
  }

  private async doWithRetries<T>(
    fn: () => Promise<T>,
    attempts?: number,
    baseDelayMs?: number
  ): Promise<T> {
    let lastErr: any;
    const tries = Math.max(1, attempts || 1);
    const base = Math.max(0, baseDelayMs || 0);

    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (i < tries - 1) {
          const jitter = Math.floor(Math.random() * 250);
          const delay = base * Math.pow(2, i) + jitter;
          if (delay > 0) {
            this.console?.log?.(`[Day/Night] Retry ${i + 1}/${tries} after ${delay}ms delay`);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    }
    throw lastErr;
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

  private async fetchWithTimeout(input: any, init: any, ms = 10000): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await fetch(input, { ...init, signal: ac.signal } as any);
    } finally {
      clearTimeout(t);
    }
  }

  private async digestFetchWithTimeout(
    client: DigestClient,
    url: string,
    init: any,
    ms = 10_000,
  ): Promise<Response> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      return await client.fetch(url, { ...init, signal: ac.signal } as any);
    } finally {
      clearTimeout(t);
    }
  }

  private async invokeAction(phase: 'day' | 'night') {
    const c = this.readConfig();
    const action = (phase === 'day' ? c.day : c.night) || {};

    if (!action.url) throw new Error(`${phase} URL not configured`);

    const method = (action.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const bodyAllowed = this.allowBody(method);

    if (action.contentType && bodyAllowed) headers['Content-Type'] = action.contentType;
    this.normaliseAndMergeHeaders(headers, action.headers);

    await this.doWithRetries(async () => {
      if (c.authType === 'digest') {
        const client = new DigestClient(c.username || '', c.password || '');
        const init: any = { method, headers };
        if (bodyAllowed && action.body) init.body = action.body;
        const response = await this.digestFetchWithTimeout(client, action.url!, init, 10_000);
        const responseText = await response.text().catch(() => '');
        const statusLine = `HTTP ${response.status} ${response.statusText}`;
        const ct = response.headers.get('content-type') || undefined;
        if (c.logResponses) {
          this.logBodyChunks(phase, statusLine, responseText, ct);
        }
        if (!response.ok) {
          throw new Error(statusLine);
        }
        return;
      } else {
        const fetchHeaders = { ...headers };
        if (c.authType === 'basic' && c.username && c.password) {
          const token = Buffer.from(`${c.username}:${c.password}`).toString('base64');
          fetchHeaders['Authorization'] = `Basic ${token}`;
        }
        const init: any = { method, headers: fetchHeaders };
        if (bodyAllowed && action.body) init.body = action.body;
        const response = await this.fetchWithTimeout(action.url!, init, 10000);
        const responseText = await response.text().catch(() => '');
        const statusLine = `HTTP ${response.status} ${response.statusText}`;
        const ct = response.headers.get('content-type') || undefined;
        if (c.logResponses) {
          this.logBodyChunks(phase, statusLine, responseText, ct);
        }
        if (!response.ok) {
          throw new Error(statusLine);
        }
      }
    }, c.retries, c.retryBaseDelayMs);
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
    const nextWhen = nextIsSunrise ? nextSunrise : nextSunset;
    const nextPhase = nextIsSunrise ? 'Day' : 'Night';
    const tz = tzLabel ? ` (${tzLabel})` : '';
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

    const todayTimesRaw = getSunTimesCached(now, c.latitude!, c.longitude!);
    const sunriseTodayRaw = this.safeTime(todayTimesRaw.sunrise);
    const sunsetTodayRaw = this.safeTime(todayTimesRaw.sunset);
    if (!sunriseTodayRaw || !sunsetTodayRaw) {
      this.saveToStorage('preview', 'No sunrise/sunset today at this location');
      this.saveToStorage('previewHtml', '<div style="color:#b00">No sunrise/sunset at this location today.</div>');
      return;
    }

    const todaySunrise = this.applyOffset(sunriseTodayRaw, c.sunriseOffsetMins);
    const todaySunset = this.applyOffset(sunsetTodayRaw, c.sunsetOffsetMins);

    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const tomorrowTimesRaw = getSunTimesCached(tomorrow, c.latitude!, c.longitude!);
    const sunriseTomorrowRaw = this.safeTime(tomorrowTimesRaw.sunrise);
    const sunsetTomorrowRaw = this.safeTime(tomorrowTimesRaw.sunset);

    const nextSunrise = todaySunrise.getTime() > now.getTime()
      ? todaySunrise
      : (sunriseTomorrowRaw ? this.applyOffset(sunriseTomorrowRaw, c.sunriseOffsetMins) : todaySunrise);
    const nextSunset = todaySunset.getTime() > now.getTime()
      ? todaySunset
      : (sunsetTomorrowRaw ? this.applyOffset(sunsetTomorrowRaw, c.sunsetOffsetMins) : todaySunset);

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
    this.clearTimers();
    this.console?.log?.('[Day/Night] Mixin released, timers cleared');
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
      {
        key: 'h_loc', type: 'html' as const, readonly: true,
        value: '<h3 style="margin:8px 0">Location &amp; Time</h3>'
      },

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
      },

      {
        key: 'global.sunriseOffsetMins',
        title: 'Sunrise offset (mins, default)',
        type: 'number' as const,
        value: get('global.sunriseOffsetMins', '0'),
        placeholder: '0',
        description: 'Default for all cameras. Positive = after sunrise; negative = before.',
      },
      {
        key: 'global.sunsetOffsetMins',
        title: 'Sunset offset (mins, default)',
        type: 'number' as const,
        value: get('global.sunsetOffsetMins', '0'),
        placeholder: '0',
        description: 'Default for all cameras. Positive = after sunset; negative = before.',
      },

      {
        key: 'h_rel', type: 'html' as const, readonly: true,
        value: '<h3 style="margin:16px 0 8px">Reliability defaults</h3>'
      },

      {
        key: 'global.retries',
        title: 'HTTP total attempts (default)',
        type: 'number' as const,
        value: get('global.retries', '1'),
        placeholder: '1',
        description: 'Total tries per request. Set 1 to disable retries.',
      },
      {
        key: 'global.retryBaseDelayMs',
        title: 'Retry base delay (ms, default)',
        type: 'number' as const,
        value: get('global.retryBaseDelayMs', '0'),
        placeholder: '500',
        description: 'Base delay for exponential back-off with jitter.',
      },
      {
        key: 'global.logResponses',
        title: 'Log HTTP responses (default)',
        type: 'boolean' as const,
        value: get('global.logResponses', 'false') === 'true',
        description: 'Logs status and up to 500 characters of response body.',
      },
    ];
  }

  async putSetting(key: string, value: SettingValue) {
    if (!key.startsWith('global.')) return;

    value = normaliseSetting(key, value);

    const v = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value ?? '');
    this.storage.setItem(key, v);

    for (const m of mixinsById.values()) {
      try { m.notifyGlobalsChanged(); } catch { }
    }
  }

  async canMixin(type: string, interfaces: string[]): Promise<string[] | null> {
    const isCamera = type === ScryptedDeviceType.Camera || interfaces?.includes(ScryptedInterface.VideoCamera);
    return isCamera ? [ScryptedInterface.Settings] : null;
  }

  async getMixin(
    mixinDevice: any,
    mixinDeviceInterfaces: ScryptedInterface[],
    mixinDeviceState: WritableDeviceState,
  ): Promise<any> {
    const mixin = new DayNightMixin({
      groupKey: GROUP_KEY,
      group: GROUP,
      mixinDevice,
      mixinDeviceInterfaces,
      mixinDeviceState,
      mixinProviderNativeId: this.nativeId!,
      getGlobal: (k: string) => this.storage.getItem(`global.${k}`) ?? undefined,
    });

    const key = mixinKey(mixinDevice);
    // If a previous instance exists for this device, release it defensively.
    const prev = mixinsById.get(key);
    if (prev && prev !== mixin) {
      try { await prev.release(); } catch { }
      await new Promise(r => setTimeout(r, 0)); // let event loop clear any pending callbacks
    }

    mixinsById.set(key, mixin);
    return mixin;
  }

  async releaseMixin(id: string, mixinDevice: any): Promise<void> {
    const key = mixinKey(mixinDevice, id);
    const inst = key ? mixinsById.get(key) : undefined;

    if (inst) {
      try { await inst.release(); } catch (e) {
        this.console?.warn?.('[Day/Night] Error during mixin release:', (e as any)?.message ?? e);
      }
      mixinsById.delete(key);
    }

    this.console?.log?.(`[Day/Night] Released mixin for device ${id}`);
  }
}
