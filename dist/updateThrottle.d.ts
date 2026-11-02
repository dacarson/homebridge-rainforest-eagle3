export interface ThrottleOptions {
    enabled: boolean;
    minChangeWatts: number;
    minChangePercent: number;
    maxIntervalSeconds: number;
}
export declare const DEFAULT_THROTTLE_OPTIONS: ThrottleOptions;
export declare class UpdateThrottle {
    readonly options: ThrottleOptions;
    private readonly debug;
    private readonly now;
    private readonly lastSent;
    private sent;
    private suppressed;
    constructor(options: ThrottleOptions, debug?: (message: string) => void, now?: () => number);
    /**
     * Returns true if `value` should be sent for `key`. When true, the value is
     * recorded as the last one sent. The first value for a key is always sent.
     */
    shouldSend(key: string, value: number): boolean;
    /** Returns sent/suppressed counts since the previous call and resets them. */
    takeStats(): {
        sent: number;
        suppressed: number;
    };
    private isSignificant;
}
/** Builds options from raw config values, falling back to defaults for missing/invalid entries. */
export declare function resolveThrottleOptions(config: {
    throttleUpdates?: unknown;
    minChangeWatts?: unknown;
    minChangePercent?: unknown;
    maxIntervalSeconds?: unknown;
}): ThrottleOptions;
//# sourceMappingURL=updateThrottle.d.ts.map