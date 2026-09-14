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
 * would not retroactively add the feature. buildClusters() therefore seeds a
 * zero-energy periodic fragment (no timestamps yet) on its very first call,
 * which is always the one register() makes, before any real reading exists
 * to diff against; every call after that computes a real delta against the
 * last *periodic* baseline (not the last poll), throttled to at most once
 * per MIN_PERIODIC_INTERVAL_S so a short poll interval (default 15s, minimum
 * 5s) doesn't turn into excessive Matter event/state churn compared to a
 * device that naturally reports once a minute. Imported and exported
 * baselines are tracked independently, since either can advance while the
 * other sits idle.
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
import type { API, Logger } from 'homebridge';
export type EnergyDirection = 'imported' | 'exported' | 'bidirectional';
export interface EnergyReadings {
    /** Signed for a 'bidirectional' meter (positive = importing, negative = exporting). */
    powerW: number;
    /** Required when direction is 'imported' or 'bidirectional'. */
    importedEnergyKWh?: number;
    /** Required when direction is 'exported' or 'bidirectional'. */
    exportedEnergyKWh?: number;
}
export declare class MatterEnergyBridge {
    private readonly log;
    private readonly direction;
    private static readonly MIN_PERIODIC_INTERVAL_S;
    private readonly api;
    private uuid;
    private registered;
    private warnedUpdate;
    private periodicState;
    constructor(api: API, log: Logger, direction: EnergyDirection);
    /**
     * Whether this Homebridge build exposes everything needed to publish this
     * meter. Logs at debug level so unsupported builds stay quiet.
     */
    isSupported(): boolean;
    private buildClusters;
    /**
     * Compute (or, between periodic reports, just return the last computed)
     * periodic-energy fragment for one energy kind. The very first call —
     * always from register(), before any real reading exists — seeds a
     * zero-energy fragment with no timestamps, purely so the PeriodicEnergy
     * feature composes at registration. Every call after that reports a real
     * delta against the last periodic baseline once MIN_PERIODIC_INTERVAL_S
     * has elapsed.
     */
    private computePeriodic;
    /**
     * Register this meter as a Matter electrical sensor.
     *
     * @param seedKey - unique per-meter key used to derive this accessory's
     * Matter UUID, distinct from the HAP accessory's UUID
     * @param displayName
     * @param serialNumber
     * @param readings - initial readings to seed the clusters with
     */
    register(seedKey: string, displayName: string, serialNumber: string, readings: EnergyReadings): Promise<boolean>;
    /**
     * Push fresh readings to the registered Matter accessory. No-op until
     * registration has succeeded.
     */
    update(readings: EnergyReadings): Promise<void>;
}
//# sourceMappingURL=matterEnergy.d.ts.map