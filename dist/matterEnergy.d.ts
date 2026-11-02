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
    private readonly nowMs;
    /** Re-send an unchanged cumulative total at least this often. */
    static readonly CUMULATIVE_HEARTBEAT_S: number;
    /** Length of one PeriodicEnergyMeasured period. */
    static readonly PERIODIC_INTERVAL_S: number;
    private readonly api;
    private readonly kinds;
    private uuid;
    private registered;
    private warnedUpdate;
    private sentFirstUpdate;
    private lastCumulative;
    private lastReadingKWh;
    private periodStartS;
    private periodKWh;
    private lastPeriodic;
    private idle;
    constructor(api: API, log: Logger, direction: EnergyDirection, nowMs?: () => number);
    /**
     * Whether this Homebridge build exposes everything needed to publish this
     * meter. Logs at debug level so unsupported builds stay quiet.
     */
    isSupported(): boolean;
    private nowS;
    private static readingsByKind;
    /** Initial cluster state for register(): every energy field, periodic seeded at zero. */
    private buildInitialClusters;
    private energyFields;
    /**
     * Decide which energy fields this poll should send, updating the cumulative
     * and periodic bookkeeping. Returns an empty object when nothing is due.
     */
    private buildEnergyUpdate;
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