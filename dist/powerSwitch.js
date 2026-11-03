"use strict";
// On/off state derived from a power reading, for the standard HomeKit On
// characteristic. Stays evented so Home automations keep working, but with
// two safeguards against flapping:
//
//  - Deadband: turns on above SWITCH_ON_ABOVE_W and off below SWITCH_OFF_BELOW_W.
//  - Hold: a new state must persist for holdSeconds before it is reported
//    (0 disables the hold). Automations triggered by the switch can therefore
//    fire up to holdSeconds (plus one poll) after the underlying change.
Object.defineProperty(exports, "__esModule", { value: true });
exports.PowerSwitch = exports.SWITCH_OFF_BELOW_W = exports.SWITCH_ON_ABOVE_W = void 0;
const updatePolicy_1 = require("./updatePolicy");
/** Switch turns on when power rises above this many watts. */
exports.SWITCH_ON_ABOVE_W = 50;
/** Switch turns off when power falls below this many watts. */
exports.SWITCH_OFF_BELOW_W = 20;
class PowerSwitch {
    constructor(key, holdSeconds, stats = new updatePolicy_1.UpdateStats(), debug = () => { }, now = Date.now) {
        this.key = key;
        this.holdSeconds = holdSeconds;
        this.stats = stats;
        this.debug = debug;
        this.now = now;
        this.reported = null;
        this.pendingSince = null;
    }
    /** The state last reported to HomeKit (false before the first reading). */
    get state() {
        return this.reported ?? false;
    }
    /**
     * Feed a new power reading. Returns the state to push to HomeKit, or null
     * when the reported state should not change. The first reading is always
     * reported immediately.
     */
    update(watts) {
        if (this.reported === null) {
            this.reported = watts > exports.SWITCH_ON_ABOVE_W;
            this.stats.sent++;
            return this.reported;
        }
        const target = this.reported ? watts >= exports.SWITCH_OFF_BELOW_W : watts > exports.SWITCH_ON_ABOVE_W;
        if (target === this.reported) {
            if (this.pendingSince !== null) {
                this.debug(`${this.key}: pending change cancelled at ${watts} W, staying ${onOff(target)}`);
                this.pendingSince = null;
            }
            return null;
        }
        const now = this.now();
        if (this.pendingSince === null) {
            this.pendingSince = now;
        }
        const heldS = (now - this.pendingSince) / 1000;
        if (heldS >= this.holdSeconds) {
            this.reported = target;
            this.pendingSince = null;
            this.stats.sent++;
            return target;
        }
        this.stats.suppressed++;
        this.debug(`${this.key}: holding change to ${onOff(target)} at ${watts} W (${heldS}s of ${this.holdSeconds}s)`);
        return null;
    }
}
exports.PowerSwitch = PowerSwitch;
function onOff(state) {
    return state ? 'on' : 'off';
}
//# sourceMappingURL=powerSwitch.js.map