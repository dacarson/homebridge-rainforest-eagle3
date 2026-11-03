import { UpdateStats } from './updatePolicy';
/** Switch turns on when power rises above this many watts. */
export declare const SWITCH_ON_ABOVE_W = 50;
/** Switch turns off when power falls below this many watts. */
export declare const SWITCH_OFF_BELOW_W = 20;
export declare class PowerSwitch {
    private readonly key;
    private readonly holdSeconds;
    private readonly stats;
    private readonly debug;
    private readonly now;
    private reported;
    private pendingSince;
    constructor(key: string, holdSeconds: number, stats?: UpdateStats, debug?: (message: string) => void, now?: () => number);
    /** The state last reported to HomeKit (false before the first reading). */
    get state(): boolean;
    /**
     * Feed a new power reading. Returns the state to push to HomeKit, or null
     * when the reported state should not change. The first reading is always
     * reported immediately.
     */
    update(watts: number): boolean | null;
}
//# sourceMappingURL=powerSwitch.d.ts.map