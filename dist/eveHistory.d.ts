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
export declare const EVE_HISTORY_INTERVAL_MS: number;
export declare const EVE_HISTORY_MAX_POWER_W = 6553.5;
export declare const EVE_HISTORY_DEFAULT_MAX_GAP_MS: number;
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
export declare class EveEnergyHistory {
    private readonly maxGapMs;
    private energyWs;
    private coveredMs;
    private lastPowerW;
    private lastSampleMs;
    constructor(maxGapMs?: number);
    /** Call on every reading. */
    sample(powerW: number, nowMs: number): void;
    /**
     * Close the current window. Returns null when no time was covered by
     * samples (no entry should be written for that window).
     */
    flush(nowMs: number): EveHistoryFlush | null;
    private integrateTo;
}
/** Largest gap between samples still counted, given the poll interval. */
export declare function eveHistoryMaxGapMs(pollIntervalMs: number): number;
export interface EveHistoryRecorderOptions {
    historyService: any;
    pollIntervalMs: number;
    name: string;
    log: {
        info(message: string): void;
        debug(message: string): void;
    };
    onShutdown(listener: () => void): void;
    now?: () => number;
}
/**
 * Wires an EveEnergyHistory to a fakegato history service (created with
 * disableTimer: true): writes one entry every 10 minutes.
 */
export declare class EveHistoryRecorder {
    private readonly opts;
    private readonly history;
    private readonly now;
    private loggedCap;
    private readonly timer;
    constructor(opts: EveHistoryRecorderOptions);
    sample(powerW: number): void;
    record(): void;
}
//# sourceMappingURL=eveHistory.d.ts.map