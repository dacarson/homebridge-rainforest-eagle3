/**
 * Eve Energy history (fakegato-history 'energy' type) recording.
 *
 * - The power field in an Eve history record is a uint16 holding watts × 10,
 *   so anything above 6553.5 W wraps silently. Values are capped instead.
 * - Eve credits each entry with power × min(time since previous entry, 600 s),
 *   so entries are written once every 10 minutes, holding the time-weighted
 *   average power over that window. fakegato's own timer averages by sample
 *   count, not time, so it is disabled (disableTimer: true).
 *
 * See docs/eve-energy-history.md.
 */

export const EVE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
export const EVE_HISTORY_MAX_POWER_W = 6553.5; // 0xffff / 10
export const EVE_HISTORY_DEFAULT_MAX_GAP_MS = 2 * 60 * 1000;

export interface EveHistoryFlush {
  /** Power to write to fakegato, capped at EVE_HISTORY_MAX_POWER_W. */
  powerW: number;
  /** Uncapped time-weighted average, rounded to 0.1 W. */
  averageW: number;
}

/**
 * Integrates power over time and produces one time-weighted average per window.
 *
 * Gaps between samples longer than maxGapMs (failed polls, gateway outages)
 * are not counted. Unlike an appliance, an unreachable meter gateway doesn't
 * mean the house drew no power, so the average is taken over the time that
 * was covered by samples, not the whole window.
 */
export class EveEnergyHistory {
  private energyWs = 0;
  private coveredMs = 0;
  private lastPowerW = 0;
  private lastSampleMs: number | null = null;

  constructor(private readonly maxGapMs = EVE_HISTORY_DEFAULT_MAX_GAP_MS) {}

  /** Call on every reading. */
  sample(powerW: number, nowMs: number): void {
    this.integrateTo(nowMs);
    this.lastPowerW = Number.isFinite(powerW) && powerW > 0 ? powerW : 0;
  }

  /**
   * Close the current window. Returns null when no time was covered by
   * samples (no entry should be written for that window).
   */
  flush(nowMs: number): EveHistoryFlush | null {
    this.integrateTo(nowMs);
    const seconds = this.coveredMs / 1000;
    const energyWs = this.energyWs;
    this.energyWs = 0;
    this.coveredMs = 0;
    if (seconds <= 0) {
      return null;
    }
    const averageW = Math.round((energyWs / seconds) * 10) / 10;
    return { powerW: Math.min(EVE_HISTORY_MAX_POWER_W, averageW), averageW };
  }

  private integrateTo(nowMs: number): void {
    if (this.lastSampleMs !== null && nowMs > this.lastSampleMs) {
      const dt = nowMs - this.lastSampleMs;
      if (dt <= this.maxGapMs) {
        this.energyWs += (this.lastPowerW * dt) / 1000;
        this.coveredMs += dt;
      }
    }
    if (this.lastSampleMs === null || nowMs > this.lastSampleMs) {
      this.lastSampleMs = nowMs;
    }
  }
}

/** Largest gap between samples still counted, given the poll interval. */
export function eveHistoryMaxGapMs(pollIntervalMs: number): number {
  return Math.max(EVE_HISTORY_DEFAULT_MAX_GAP_MS, Math.round(pollIntervalMs * 2.5));
}

export interface EveHistoryRecorderOptions {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  historyService: any;
  pollIntervalMs: number;
  name: string;
  log: { info(message: string): void; debug(message: string): void };
  onShutdown(listener: () => void): void;
  now?: () => number;
}

/**
 * Wires an EveEnergyHistory to a fakegato history service (created with
 * disableTimer: true): writes one entry every 10 minutes.
 */
export class EveHistoryRecorder {
  private readonly history: EveEnergyHistory;
  private readonly now: () => number;
  private loggedCap = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: EveHistoryRecorderOptions) {
    this.now = opts.now ?? Date.now;
    this.history = new EveEnergyHistory(eveHistoryMaxGapMs(opts.pollIntervalMs));
    this.timer = setInterval(() => this.record(), EVE_HISTORY_INTERVAL_MS);
    this.timer.unref?.();
    opts.onShutdown(() => clearInterval(this.timer));
  }

  sample(powerW: number): void {
    this.history.sample(powerW, this.now());
  }

  record(): void {
    const nowMs = this.now();
    const result = this.history.flush(nowMs);
    if (!result) {
      this.opts.log.debug(`[${this.opts.name}] Eve history: no readings in the last window, skipping entry`);
      return;
    }
    if (result.averageW > result.powerW && !this.loggedCap) {
      this.loggedCap = true;
      this.opts.log.info(
        `[${this.opts.name}] Average power ${result.averageW} W is above the Eve history limit of ` +
          `${EVE_HISTORY_MAX_POWER_W} W; Eve history is capped at that value. ` +
          'Eve Watts, Eve kWh and Matter values are not affected.',
      );
    }
    this.opts.historyService.addEntry({ time: Math.round(nowMs / 1000), power: result.powerW });
    this.opts.log.debug(`[${this.opts.name}] Eve history entry: ${result.powerW} W (average ${result.averageW} W)`);
  }
}
