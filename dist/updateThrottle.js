"use strict";
// Throttles Eve Watts HomeKit events. The EAGLE is polled every ~15 s and the
// demand reading differs slightly on nearly every poll, so pushing every value
// produces a steady stream of HomeKit events for no visible benefit. This
// helper decides, per accessory+characteristic key, whether a new value is
// worth sending.
Object.defineProperty(exports, "__esModule", { value: true });
exports.UpdateThrottle = exports.DEFAULT_THROTTLE_OPTIONS = void 0;
exports.resolveThrottleOptions = resolveThrottleOptions;
exports.DEFAULT_THROTTLE_OPTIONS = {
    enabled: true,
    minChangeWatts: 25,
    minChangePercent: 2,
    maxIntervalSeconds: 300,
};
class UpdateThrottle {
    constructor(options, debug = () => { }, now = Date.now) {
        this.options = options;
        this.debug = debug;
        this.now = now;
        this.lastSent = new Map();
        this.sent = 0;
        this.suppressed = 0;
    }
    /**
     * Returns true if `value` should be sent for `key`. When true, the value is
     * recorded as the last one sent. The first value for a key is always sent.
     */
    shouldSend(key, value) {
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
    takeStats() {
        const stats = { sent: this.sent, suppressed: this.suppressed };
        this.sent = 0;
        this.suppressed = 0;
        return stats;
    }
    isSignificant(last, value, now) {
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
exports.UpdateThrottle = UpdateThrottle;
/** Builds options from raw config values, falling back to defaults for missing/invalid entries. */
function resolveThrottleOptions(config) {
    const num = (v, fallback) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
    const d = exports.DEFAULT_THROTTLE_OPTIONS;
    return {
        enabled: typeof config.throttleUpdates === 'boolean' ? config.throttleUpdates : d.enabled,
        minChangeWatts: num(config.minChangeWatts, d.minChangeWatts),
        minChangePercent: num(config.minChangePercent, d.minChangePercent),
        maxIntervalSeconds: num(config.maxIntervalSeconds, d.maxIntervalSeconds),
    };
}
//# sourceMappingURL=updateThrottle.js.map