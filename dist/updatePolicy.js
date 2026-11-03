"use strict";
// Controls how much HomeKit event traffic the plugin generates.
//
// The EAGLE is polled every ~15 s and its readings differ slightly on nearly
// every poll. Pushing every value produces a steady stream of HomeKit events,
// so the Eve custom power/energy characteristics are pushed according to the
// `evePowerUpdates` mode:
//
//   throttled (default) — push when the value changes by at least the
//                          configured threshold, or maxIntervalSeconds after
//                          the last push
//   pollOnly             — never push; NOTIFY is removed, values are served
//                          from onGet only
//   live                 — push every poll (behavior before 1.2.0)
//
// Standard HomeKit characteristics are always evented; the power-derived On
// switches are handled separately by PowerSwitch (see powerSwitch.ts).
Object.defineProperty(exports, "__esModule", { value: true });
exports.EveUpdateThrottle = exports.UpdateStats = exports.DEFAULT_UPDATE_POLICY = exports.EVE_POWER_UPDATE_MODES = void 0;
exports.resolveUpdatePolicy = resolveUpdatePolicy;
exports.EVE_POWER_UPDATE_MODES = ['throttled', 'pollOnly', 'live'];
exports.DEFAULT_UPDATE_POLICY = {
    evePowerUpdates: 'throttled',
    minChangeWatts: 25,
    minChangePercent: 2,
    minChangeKwh: 0.1,
    maxIntervalSeconds: 300,
    switchHoldSeconds: 60,
};
/** Builds options from raw config values, falling back to defaults for missing/invalid entries. */
function resolveUpdatePolicy(config) {
    const d = exports.DEFAULT_UPDATE_POLICY;
    const num = (v, fallback) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
    const mode = config.evePowerUpdates;
    return {
        evePowerUpdates: exports.EVE_POWER_UPDATE_MODES.includes(mode)
            ? mode
            : d.evePowerUpdates,
        minChangeWatts: num(config.minChangeWatts, d.minChangeWatts),
        minChangePercent: num(config.minChangePercent, d.minChangePercent),
        minChangeKwh: num(config.minChangeKwh, d.minChangeKwh),
        maxIntervalSeconds: num(config.maxIntervalSeconds, d.maxIntervalSeconds),
        switchHoldSeconds: num(config.switchHoldSeconds, d.switchHoldSeconds),
    };
}
/** Sent/suppressed counters for the hourly summary log. */
class UpdateStats {
    constructor() {
        this.sent = 0;
        this.suppressed = 0;
    }
    /** Returns the counts since the previous call and resets them. */
    take() {
        const stats = { sent: this.sent, suppressed: this.suppressed };
        this.sent = 0;
        this.suppressed = 0;
        return stats;
    }
}
exports.UpdateStats = UpdateStats;
/** Decides, per accessory+characteristic key, whether an Eve value is pushed. */
class EveUpdateThrottle {
    constructor(options, stats = new UpdateStats(), debug = () => { }, now = Date.now) {
        this.options = options;
        this.stats = stats;
        this.debug = debug;
        this.now = now;
        this.lastSent = new Map();
    }
    /** Whether Eve characteristics should advertise NOTIFY (false in pollOnly mode). */
    get notify() {
        return this.options.evePowerUpdates !== 'pollOnly';
    }
    /**
     * Returns true if `value` should be pushed for `key`. The first value for a
     * key is always pushed in throttled mode, so HomeKit gets the correct value
     * immediately on startup.
     */
    shouldSend(key, value, unit) {
        switch (this.options.evePowerUpdates) {
            case 'live':
                this.stats.sent++;
                return true;
            case 'pollOnly':
                this.stats.suppressed++;
                return false;
        }
        const now = this.now();
        const last = this.lastSent.get(key);
        if (last === undefined || this.isSignificant(last, value, unit, now)) {
            this.lastSent.set(key, { value, time: now });
            this.stats.sent++;
            return true;
        }
        this.stats.suppressed++;
        this.debug(`Suppressed ${key} update ${value} ${unit} (last sent ${last.value} ${unit})`);
        return false;
    }
    isSignificant(last, value, unit, now) {
        const { minChangeWatts, minChangePercent, minChangeKwh, maxIntervalSeconds } = this.options;
        // Sign change, including crossing to/from 0 (import vs export).
        if (Math.sign(value) !== Math.sign(last.value)) {
            return true;
        }
        const threshold = unit === 'W'
            ? Math.max(minChangeWatts, (minChangePercent / 100) * Math.abs(last.value))
            : minChangeKwh;
        if (Math.abs(value - last.value) >= threshold) {
            return true;
        }
        return now - last.time >= maxIntervalSeconds * 1000;
    }
}
exports.EveUpdateThrottle = EveUpdateThrottle;
//# sourceMappingURL=updatePolicy.js.map