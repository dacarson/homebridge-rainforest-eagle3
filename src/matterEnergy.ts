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
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';

/** Matter expresses power in milliwatts. */
function wToMilliW(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/** Matter expresses energy in milliwatt-hours; EAGLE readings are in kWh. */
function kWhToMilliWh(value: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(Math.max(0, n) * 1_000_000) : 0;
}

// Which way energy flows through this meter, from the meter's own point of
// view. The EAGLE grid meter is always bidirectional (see the file header
// note on imported/exported energy always being separate attributes).
export type EnergyDirection = 'imported' | 'exported' | 'bidirectional';

export interface EnergyReadings {
  /** Signed for a 'bidirectional' meter (positive = importing, negative = exporting). */
  powerW: number;
  /** Required when direction is 'imported' or 'bidirectional'. */
  importedEnergyKWh?: number;
  /** Required when direction is 'exported' or 'bidirectional'. */
  exportedEnergyKWh?: number;
}

// Matter's EnergyMeasurementStruct. `energy` (mWh) is mandatory;
// startTimestamp/endTimestamp (Unix seconds — matter.js converts to Matter's
// native epoch-s) are omitted for a not-yet-measured seed value and present
// once a real interval has been measured.
interface EnergyStruct {
  energy: number;
  startTimestamp?: number;
  endTimestamp?: number;
}

type EnergyKind = 'imported' | 'exported';

interface MatterAccessoryClusters {
  electricalPowerMeasurement: { activePower: number };
  electricalEnergyMeasurement: {
    cumulativeEnergyImported?: EnergyStruct;
    periodicEnergyImported?: EnergyStruct;
    cumulativeEnergyExported?: EnergyStruct;
    periodicEnergyExported?: EnergyStruct;
  };
}

interface MatterAccessoryDefinition {
  UUID: string;
  displayName: string;
  deviceType: unknown;
  serialNumber?: string;
  manufacturer?: string;
  model?: string;
  clusters: MatterAccessoryClusters;
}

// Minimal shape of the subset of Homebridge's Matter plugin API this module
// uses. Not imported from 'homebridge' because the type declarations for
// api.matter only ship with Homebridge 2.2+; this keeps the plugin buildable
// against older @types without pulling in a hard dependency on them.
interface MatterAPILike {
  deviceTypes: { ElectricalSensor?: unknown };
  registerPlatformAccessories: (
    pluginIdentifier: string,
    platformName: string,
    accessories: MatterAccessoryDefinition[],
  ) => Promise<void>;
  updateAccessoryState: (uuid: string, cluster: string, state: unknown) => Promise<void>;
  uuid: { generate: (seed: string) => string };
}

type APIWithMatter = API & { matter?: MatterAPILike };

export class MatterEnergyBridge {
  private static readonly MIN_PERIODIC_INTERVAL_S = 60;

  private readonly api: APIWithMatter;
  private uuid: string | null = null;
  private registered = false;
  private warnedUpdate = false;

  // Periodic-energy bookkeeping — see the "Cumulative vs. periodic energy"
  // note at the top of this file. Tracked per energy kind so the
  // bidirectional meter can advance its imported and exported deltas
  // independently.
  private periodicState: Record<EnergyKind, { baselineKWh: number | null; timestampS: number | null; last: EnergyStruct }> = {
    imported: { baselineKWh: null, timestampS: null, last: { energy: 0 } },
    exported: { baselineKWh: null, timestampS: null, last: { energy: 0 } },
  };

  constructor(
    api: API,
    private readonly log: Logger,
    private readonly direction: EnergyDirection,
  ) {
    this.api = api as APIWithMatter;
  }

  /**
   * Whether this Homebridge build exposes everything needed to publish this
   * meter. Logs at debug level so unsupported builds stay quiet.
   */
  isSupported(): boolean {
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

  private buildClusters(r: EnergyReadings): MatterAccessoryClusters {
    const energyField: MatterAccessoryClusters['electricalEnergyMeasurement'] = {};

    if (this.direction === 'imported' || this.direction === 'bidirectional') {
      energyField.cumulativeEnergyImported = { energy: kWhToMilliWh(r.importedEnergyKWh ?? 0) };
      energyField.periodicEnergyImported = this.computePeriodic('imported', r.importedEnergyKWh ?? 0);
    }
    if (this.direction === 'exported' || this.direction === 'bidirectional') {
      energyField.cumulativeEnergyExported = { energy: kWhToMilliWh(r.exportedEnergyKWh ?? 0) };
      energyField.periodicEnergyExported = this.computePeriodic('exported', r.exportedEnergyKWh ?? 0);
    }

    return {
      electricalPowerMeasurement: { activePower: wToMilliW(r.powerW) },
      electricalEnergyMeasurement: energyField,
    };
  }

  /**
   * Compute (or, between periodic reports, just return the last computed)
   * periodic-energy fragment for one energy kind. The very first call —
   * always from register(), before any real reading exists — seeds a
   * zero-energy fragment with no timestamps, purely so the PeriodicEnergy
   * feature composes at registration. Every call after that reports a real
   * delta against the last periodic baseline once MIN_PERIODIC_INTERVAL_S
   * has elapsed.
   */
  private computePeriodic(kind: EnergyKind, energyKWh: number): EnergyStruct {
    const state = this.periodicState[kind];
    const nowS = Math.floor(Date.now() / 1000);

    if (state.baselineKWh === null || state.timestampS === null) {
      state.baselineKWh = energyKWh;
      state.timestampS = nowS;
      return state.last;
    }

    if (nowS - state.timestampS >= MatterEnergyBridge.MIN_PERIODIC_INTERVAL_S) {
      const deltaKWh = Math.max(0, energyKWh - state.baselineKWh);
      state.last = {
        energy: kWhToMilliWh(deltaKWh),
        startTimestamp: state.timestampS,
        endTimestamp: nowS,
      };
      state.baselineKWh = energyKWh;
      state.timestampS = nowS;
    }

    return state.last;
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
  async register(seedKey: string, displayName: string, serialNumber: string, readings: EnergyReadings): Promise<boolean> {
    if (!this.isSupported()) return false;
    const matter = this.api.matter!;
    this.uuid = matter.uuid.generate(`${PLUGIN_NAME}:matter:${seedKey}`);

    const accessory: MatterAccessoryDefinition = {
      UUID: this.uuid,
      displayName,
      deviceType: matter.deviceTypes.ElectricalSensor,
      serialNumber,
      manufacturer: 'Rainforest Automation',
      model: 'EAGLE-3',
      clusters: this.buildClusters(readings),
    };

    try {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registered = true;
      this.log.info(`[matter] Published "${displayName}" as a Matter electrical sensor — live power should feed the Apple Home Energy view.`);
      return true;
    } catch (err) {
      this.log.warn(`[matter] Failed to register Matter accessory for "${displayName}" (${err instanceof Error ? err.message : err}). Continuing with HomeKit/Eve only.`);
      this.registered = false;
      return false;
    }
  }

  /**
   * Push fresh readings to the registered Matter accessory. No-op until
   * registration has succeeded.
   */
  async update(readings: EnergyReadings): Promise<void> {
    if (!this.registered || !this.uuid) return;
    const matter = this.api.matter;
    if (!matter) return;

    const clusters = this.buildClusters(readings);

    try {
      await Promise.all([
        matter.updateAccessoryState(this.uuid, 'electricalPowerMeasurement', clusters.electricalPowerMeasurement),
        matter.updateAccessoryState(this.uuid, 'electricalEnergyMeasurement', clusters.electricalEnergyMeasurement),
      ]);
    } catch (err) {
      // Log the first failure at warn, the rest at debug, so a persistently
      // unhappy Matter server can't flood the log on every poll.
      const message = `[matter] Failed to update Matter state: ${err instanceof Error ? err.message : err}`;
      if (!this.warnedUpdate) {
        this.warnedUpdate = true;
        this.log.warn(message);
      } else {
        this.log.debug(message);
      }
    }
  }
}
