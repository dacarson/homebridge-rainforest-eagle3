"use strict";
/**
 * matterEnergy.ts
 *
 * Publishes the EAGLE grid meter to Matter controllers as a single
 * bidirectional ElectricalSensor reporting live power and cumulative /
 * periodic energy, so it feeds the Apple Home Energy view (iOS 27+).
 *
 * Background
 * ----------
 * Apple Home's Energy view is driven by Matter electrical-measurement
 * clusters, not by classic HomeKit/HAP characteristics. HAP has no native
 * power/energy characteristic, so the Eve custom characteristics this plugin
 * also exposes (see eveCharacteristics.ts) are only ever read by Eve-class
 * apps and never populate the native Energy tile.
 *
 * Device type: ElectricalSensor, not OnOffOutlet
 * -----------------------------------------------
 * A pure metering device type like ElectricalSensor has no actionable
 * primary cluster, so its tile in the Home app shows "Not Supported" as its
 * headline status. That's an accepted tradeoff here: the meter is not
 * actually controllable, and an on/off state would only ever be a workaround
 * for the tile headline — the wattage still rolls into the Home aggregate
 * and (via PeriodicEnergy, below) into this accessory's own Energy-view
 * attribution either way.
 *
 *   powerW    -> electricalPowerMeasurement.activePower                        (mW, signed)
 *   energyKWh -> electricalEnergyMeasurement.cumulativeEnergyImported.energy   (mWh)
 *             and .cumulativeEnergyExported.energy, since the grid meter is
 *             bidirectional (see EnergyDirection below).
 *
 * Matter expresses power in milliwatts and energy in milliwatt-hours, hence
 * the x1000 / x1,000,000 conversions. cumulativeEnergyImported/Exported are
 * themselves structs (EnergyMeasurementStruct — { energy, startTimestamp?,
 * endTimestamp?, ... }), not plain numbers: Homebridge's updateAccessoryState()
 * accepts and normalizes a flat number for convenience, but the *initial*
 * state passed at registration goes straight to matter.js's struct-typed
 * attribute and must already be an object, or registration fails with
 * "Cannot manage number because it is not a struct".
 *
 * Homebridge derives the mandatory cluster attributes (powerMode, accuracy,
 * numberOfMeasurementTypes) and the feature-gated ElectricalEnergyMeasurement
 * features from the declared state — declaring `cumulativeEnergyImported`
 * selects the ImportedEnergy + CumulativeEnergy features, `cumulativeEnergyExported`
 * selects ExportedEnergy + CumulativeEnergy, and both together (for a
 * bidirectional meter) select both pairs at once. No voltage/current data is
 * available from the EAGLE's local API, so only activePower is declared;
 * voltage/activeCurrent are optional per the Matter spec and are simply
 * omitted.
 *
 * Imported vs. exported energy is always two separate attributes
 * ------------------------------------------------------------
 * `activePower` is a signed attribute (positive = importing, negative =
 * exporting), so this single bidirectional meter can report live direction
 * with one accessory. Cumulative/periodic *energy* has no equivalent signed
 * "net" attribute, though: Imported and Exported are distinct lifetime
 * running totals per the Matter spec (you don't want a day's export and
 * import cancelling each other out), so the meter declares both
 * `cumulativeEnergyImported` and `cumulativeEnergyExported` (and their
 * periodic counterparts) together on the same cluster. This is how the grid
 * meter is published as a single Matter accessory even though it remains two
 * separate accessories in Eve/HomeKit (Grid Meter - Import / Grid Meter -
 * Export) when `showExportMeter` is enabled, since that split is purely
 * about Eve's inability to represent a negative watt value, not a Matter
 * limitation.
 *
 * Cumulative vs. periodic energy
 * ------------------------------
 * Alongside the cumulative (lifetime) total, this module also declares the
 * PeriodicEnergy feature (`periodicEnergyImported`/`periodicEnergyExported`)
 * — a per-interval delta with its own start/end timestamps. Per prior art in
 * homebridge-shelly-matter (github.com/keremerkan/homebridge-shelly-matter,
 * shellyAccessory.ts), this is what drives Apple Home's per-device energy
 * attribution in the Energy view, not the cumulative total alone. Matter
 * features compose once at registration, so PeriodicEnergy must already be
 * present in the *initial* cluster state passed to registerPlatformAccessories()
 * — declaring it for the first time in a later updateAccessoryState() call
 * would not retroactively add the feature. register() therefore seeds a
 * zero-energy periodic fragment (no timestamps yet).
 *
 * Event rate
 * ----------
 * Homebridge routes every energy field passed to updateAccessoryState() through
 * matter.js setMeasurement(), which records a CumulativeEnergyMeasured or
 * PeriodicEnergyMeasured event for each one. Sending both on every poll
 * (default 15s) produced events that almost always repeated the previous
 * total or reported 0 energy, so update() includes each field only when it
 * carries news:
 *
 * - Cumulative: when the total (in mWh) has changed since the last one sent,
 *   or CUMULATIVE_HEARTBEAT_S has passed, so controllers still get a periodic
 *   heartbeat while the meter is idle.
 * - Periodic: energy is accumulated across polls (per-poll deltas, so a meter
 *   counter that steps backwards doesn't produce a negative period) and
 *   emitted once per PERIODIC_INTERVAL_S, with start/end timestamps covering
 *   the whole period. If the previous period was idle (zero energy) and energy
 *   starts flowing, the period is emitted immediately and a new one starts, so
 *   a new session starts reporting promptly instead of up to 15 minutes later.
 *
 * The periodic baseline is taken from the first real poll, not from the
 * placeholder readings register() is called with. The first update() after
 * registration always sends both fields, as before.
 *
 * Requirements
 * ------------
 * - Homebridge 2.4.0+
 * - Matter enabled on this plugin's child bridge (Homebridge UI ->
 *   plugin settings -> Bridge Settings -> enable Matter)
 * - iOS/iPadOS 27+ on the device used to view the Apple Home Energy view
 *
 * Everything here is feature-detected and guarded: on a Homebridge build
 * without the Matter API, or with Matter disabled, isSupported() returns
 * false and the plugin runs HAP/Eve-only exactly as before.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MatterEnergyBridge = void 0;
const settings_1 = require("./settings");
/** Matter expresses power in milliwatts. */
function wToMilliW(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}
/** Matter expresses energy in milliwatt-hours; EAGLE readings are in kWh. */
function kWhToMilliWh(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(Math.max(0, n) * 1000000) : 0;
}
const ENERGY_KINDS = {
    imported: ['imported'],
    exported: ['exported'],
    bidirectional: ['imported', 'exported'],
};
class MatterEnergyBridge {
    constructor(api, log, direction, nowMs = Date.now) {
        this.log = log;
        this.direction = direction;
        this.nowMs = nowMs;
        this.uuid = null;
        this.registered = false;
        this.warnedUpdate = false;
        this.sentFirstUpdate = false;
        // Cumulative energy last sent (mWh) and when.
        this.lastCumulative = null;
        // Periodic-energy bookkeeping — see "Event rate" at the top of this file.
        this.lastReadingKWh = null;
        this.periodStartS = 0;
        this.periodKWh = { imported: 0, exported: 0 };
        this.lastPeriodic = {
            imported: { energy: 0 },
            exported: { energy: 0 },
        };
        // True while the last emitted period carried no energy (and at startup).
        this.idle = true;
        this.api = api;
        this.kinds = ENERGY_KINDS[direction];
    }
    /**
     * Whether this Homebridge build exposes everything needed to publish this
     * meter. Logs at debug level so unsupported builds stay quiet.
     */
    isSupported() {
        const matter = this.api.matter;
        if (!matter) {
            this.log.debug('[matter] api.matter unavailable — Matter energy export disabled. Requires Homebridge 2.4.0+ with Matter enabled on this plugin\'s child bridge.');
            return false;
        }
        if (!matter.deviceTypes?.ElectricalSensor) {
            this.log.debug('[matter] api.matter.deviceTypes.ElectricalSensor unavailable — Matter energy export disabled. Requires a newer Homebridge build.');
            return false;
        }
        if (typeof matter.registerPlatformAccessories !== 'function' || typeof matter.updateAccessoryState !== 'function') {
            this.log.debug('[matter] Matter registration/update API unavailable — Matter energy export disabled.');
            return false;
        }
        return true;
    }
    nowS() {
        return Math.floor(this.nowMs() / 1000);
    }
    static readingsByKind(r) {
        return { imported: r.importedEnergyKWh ?? 0, exported: r.exportedEnergyKWh ?? 0 };
    }
    /** Initial cluster state for register(): every energy field, periodic seeded at zero. */
    buildInitialClusters(r) {
        const kWh = MatterEnergyBridge.readingsByKind(r);
        const mWh = { imported: kWhToMilliWh(kWh.imported), exported: kWhToMilliWh(kWh.exported) };
        this.lastCumulative = { mWh, timeS: this.nowS() };
        return {
            electricalPowerMeasurement: { activePower: wToMilliW(r.powerW) },
            electricalEnergyMeasurement: this.energyFields(mWh, true),
        };
    }
    energyFields(cumulativeMWh, includePeriodic) {
        const out = {};
        for (const kind of this.kinds) {
            const suffix = kind === 'imported' ? 'Imported' : 'Exported';
            if (cumulativeMWh) {
                out[`cumulativeEnergy${suffix}`] = { energy: cumulativeMWh[kind] };
            }
            if (includePeriodic) {
                out[`periodicEnergy${suffix}`] = this.lastPeriodic[kind];
            }
        }
        return out;
    }
    /**
     * Decide which energy fields this poll should send, updating the cumulative
     * and periodic bookkeeping. Returns an empty object when nothing is due.
     */
    buildEnergyUpdate(r) {
        const nowS = this.nowS();
        const kWh = MatterEnergyBridge.readingsByKind(r);
        const first = !this.sentFirstUpdate;
        this.sentFirstUpdate = true;
        // Periodic: accumulate this poll's delta, emit at the end of a period or
        // as soon as energy starts flowing after an idle period.
        let emitPeriodic = false;
        if (this.lastReadingKWh === null) {
            this.periodStartS = nowS;
        }
        else {
            for (const kind of this.kinds) {
                this.periodKWh[kind] += Math.max(0, kWh[kind] - this.lastReadingKWh[kind]);
            }
            const hasEnergy = this.kinds.some((k) => kWhToMilliWh(this.periodKWh[k]) > 0);
            const periodOver = nowS - this.periodStartS >= MatterEnergyBridge.PERIODIC_INTERVAL_S;
            if (periodOver || (this.idle && hasEnergy)) {
                emitPeriodic = true;
                for (const kind of this.kinds) {
                    this.lastPeriodic[kind] = {
                        energy: kWhToMilliWh(this.periodKWh[kind]),
                        startTimestamp: this.periodStartS,
                        endTimestamp: nowS,
                    };
                    this.periodKWh[kind] = 0;
                }
                this.idle = !hasEnergy;
                this.periodStartS = nowS;
            }
        }
        this.lastReadingKWh = kWh;
        // Cumulative: send on change or heartbeat.
        const mWh = { imported: kWhToMilliWh(kWh.imported), exported: kWhToMilliWh(kWh.exported) };
        const last = this.lastCumulative;
        const sendCumulative = first ||
            last === null ||
            this.kinds.some((k) => mWh[k] !== last.mWh[k]) ||
            nowS - last.timeS >= MatterEnergyBridge.CUMULATIVE_HEARTBEAT_S;
        if (sendCumulative) {
            this.lastCumulative = { mWh, timeS: nowS };
        }
        return this.energyFields(sendCumulative ? mWh : null, first || emitPeriodic);
    }
    /**
     * Register this meter as a Matter electrical sensor.
     *
     * @param seedKey - unique per-meter key used to derive this accessory's
     * Matter UUID, distinct from the HAP accessory's UUID
     * @param displayName
     * @param serialNumber
     * @param readings - initial readings to seed the clusters with
     */
    async register(seedKey, displayName, serialNumber, readings) {
        if (!this.isSupported())
            return false;
        const matter = this.api.matter;
        this.uuid = matter.uuid.generate(`${settings_1.PLUGIN_NAME}:matter:${seedKey}`);
        const accessory = {
            UUID: this.uuid,
            displayName,
            deviceType: matter.deviceTypes.ElectricalSensor,
            serialNumber,
            manufacturer: 'Rainforest Automation',
            model: 'EAGLE-3',
            clusters: this.buildInitialClusters(readings),
        };
        try {
            await matter.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.registered = true;
            this.log.info(`[matter] Published "${displayName}" as a Matter electrical sensor — live power should feed the Apple Home Energy view.`);
            return true;
        }
        catch (err) {
            this.log.warn(`[matter] Failed to register Matter accessory for "${displayName}" (${err instanceof Error ? err.message : err}). Continuing with HomeKit/Eve only.`);
            this.registered = false;
            return false;
        }
    }
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    async update(readings) {
        if (!this.registered || !this.uuid)
            return;
        const matter = this.api.matter;
        if (!matter)
            return;
        const energy = this.buildEnergyUpdate(readings);
        try {
            const updates = [
                matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', {
                    activePower: wToMilliW(readings.powerW),
                }),
            ];
            // Every energy field sent records a Matter event, so skip the call
            // entirely when nothing is due.
            if (Object.keys(energy).length > 0) {
                updates.push(matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', energy));
            }
            await Promise.all(updates);
        }
        catch (err) {
            // Log the first failure at warn, the rest at debug, so a persistently
            // unhappy Matter server can't flood the log on every poll.
            const message = `[matter] Failed to update Matter state: ${err instanceof Error ? err.message : err}`;
            if (!this.warnedUpdate) {
                this.warnedUpdate = true;
                this.log.warn(message);
            }
            else {
                this.log.debug(message);
            }
        }
    }
}
exports.MatterEnergyBridge = MatterEnergyBridge;
/** Re-send an unchanged cumulative total at least this often. */
MatterEnergyBridge.CUMULATIVE_HEARTBEAT_S = 15 * 60;
/** Length of one PeriodicEnergyMeasured period. */
MatterEnergyBridge.PERIODIC_INTERVAL_S = 15 * 60;
//# sourceMappingURL=matterEnergy.js.map