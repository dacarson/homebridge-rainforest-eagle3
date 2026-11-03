export type EvePowerUpdates = 'throttled' | 'pollOnly' | 'live';
export declare const EVE_POWER_UPDATE_MODES: readonly EvePowerUpdates[];
export type EveUnit = 'W' | 'kWh';
export interface UpdatePolicyOptions {
    evePowerUpdates: EvePowerUpdates;
    minChangeWatts: number;
    minChangePercent: number;
    minChangeKwh: number;
    maxIntervalSeconds: number;
    switchHoldSeconds: number;
}
export declare const DEFAULT_UPDATE_POLICY: UpdatePolicyOptions;
/** Builds options from raw config values, falling back to defaults for missing/invalid entries. */
export declare function resolveUpdatePolicy(config: Record<string, unknown>): UpdatePolicyOptions;
/** Sent/suppressed counters for the hourly summary log. */
export declare class UpdateStats {
    sent: number;
    suppressed: number;
    /** Returns the counts since the previous call and resets them. */
    take(): {
        sent: number;
        suppressed: number;
    };
}
/** Decides, per accessory+characteristic key, whether an Eve value is pushed. */
export declare class EveUpdateThrottle {
    private readonly options;
    readonly stats: UpdateStats;
    private readonly debug;
    private readonly now;
    private readonly lastSent;
    constructor(options: UpdatePolicyOptions, stats?: UpdateStats, debug?: (message: string) => void, now?: () => number);
    /** Whether Eve characteristics should advertise NOTIFY (false in pollOnly mode). */
    get notify(): boolean;
    /**
     * Returns true if `value` should be pushed for `key`. The first value for a
     * key is always pushed in throttled mode, so HomeKit gets the correct value
     * immediately on startup.
     */
    shouldSend(key: string, value: number, unit: EveUnit): boolean;
    private isSignificant;
}
//# sourceMappingURL=updatePolicy.d.ts.map