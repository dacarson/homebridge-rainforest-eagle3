// Throttles Eve Watts HomeKit events. The EAGLE is polled every ~15 s and the
// demand reading differs slightly on nearly every poll, so pushing every value
// produces a steady stream of HomeKit events for no visible benefit. This
// helper decides, per accessory+characteristic key, whether a new value is
// worth sending.

export interface ThrottleOptions {
  enabled: boolean;
  minChangeWatts: number;
  minChangePercent: number;
  maxIntervalSeconds: number;
}

export const DEFAULT_THROTTLE_OPTIONS: ThrottleOptions = {
  enabled: true,
  minChangeWatts: 25,
  minChangePercent: 2,
  maxIntervalSeconds: 300,
};

interface LastSent {
  value: number;
  time: number;
}

export class UpdateThrottle {
  private readonly lastSent = new Map<string, LastSent>();
  private sent = 0;
  private suppressed = 0;

  constructor(
    public readonly options: ThrottleOptions,
    private readonly debug: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns true if `value` should be sent for `key`. When true, the value is
   * recorded as the last one sent. The first value for a key is always sent.
   */
  shouldSend(key: string, value: number): boolean {
    if (!this.options.enabled) {
      return true;
    }

    const now = this.now();
    const last = this.lastSent.get(key);

    if (last === undefined || this.isSignificant(last, value, now)) {
      this.lastSent.set(key, { value, time: now });
      this.sent++;
      return true;
    }

    this.suppressed++;
    this.debug(`Throttle: suppressed ${key} update ${value} (last sent ${last.value})`);
    return false;
  }

  /** Returns sent/suppressed counts since the previous call and resets them. */
  takeStats(): { sent: number; suppressed: number } {
    const stats = { sent: this.sent, suppressed: this.suppressed };
    this.sent = 0;
    this.suppressed = 0;
    return stats;
  }

  private isSignificant(last: LastSent, value: number, now: number): boolean {
    const { minChangeWatts, minChangePercent, maxIntervalSeconds } = this.options;

    // Sign change, including crossing to/from 0 (import vs export).
    if (Math.sign(value) !== Math.sign(last.value)) {
      return true;
    }

    const threshold = Math.max(minChangeWatts, (minChangePercent / 100) * Math.abs(last.value));
    if (Math.abs(value - last.value) >= threshold) {
      return true;
    }

    return now - last.time >= maxIntervalSeconds * 1000;
  }
}

/** Builds options from raw config values, falling back to defaults for missing/invalid entries. */
export function resolveThrottleOptions(config: {
  throttleUpdates?: unknown;
  minChangeWatts?: unknown;
  minChangePercent?: unknown;
  maxIntervalSeconds?: unknown;
}): ThrottleOptions {
  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const d = DEFAULT_THROTTLE_OPTIONS;
  return {
    enabled: typeof config.throttleUpdates === 'boolean' ? config.throttleUpdates : d.enabled,
    minChangeWatts: num(config.minChangeWatts, d.minChangeWatts),
    minChangePercent: num(config.minChangePercent, d.minChangePercent),
    maxIntervalSeconds: num(config.maxIntervalSeconds, d.maxIntervalSeconds),
  };
}
