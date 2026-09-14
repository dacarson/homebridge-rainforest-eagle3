import {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, EAGLEConfig } from './settings';
import { EagleClient, HttpError } from './eagleClient';
import { GridMeterAccessory } from './gridMeterAccessory';
import { ExportMeterAccessory } from './exportMeterAccessory';
import { createEveCharacteristics, EveChars } from './eveCharacteristics';
import { MatterEnergyBridge } from './matterEnergy';

const MIN_POLL_INTERVAL = 5;
const DISCOVER_RETRY_MS = 30_000;
const NO_METER_RETRY_MS = 60_000;
const AUTH_BACKOFF_MS = 60_000;

export class EAGLEPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public readonly eveChars: EveChars;
  public readonly meterName: string;
  public readonly showExportMeter: boolean;
  public readonly exportMeterName: string;
  public readonly matterEnabled: boolean;

  private readonly client: EagleClient;
  private readonly pollIntervalMs: number;

  private gridMeterAccessory?: GridMeterAccessory;
  private exportMeterAccessory?: ExportMeterAccessory;
  // Optional: publishes the grid meter over Matter as a single bidirectional
  // ElectricalSensor (live power + cumulative/periodic energy on one
  // cluster) — see matterEnergy.ts. The Import/Export split stays HomeKit/Eve
  // only, since that's purely about Eve's inability to represent a negative
  // watt value, not a Matter limitation.
  private gridMatterBridge?: MatterEnergyBridge;
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollInFlight = false;
  private backedOff = false;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.eveChars = createEveCharacteristics(api);

    const eagleConfig = config as EAGLEConfig;

    if (!eagleConfig.cloudId || !eagleConfig.installCode) {
      this.log.error('Missing required config: cloudId and installCode are required.');
      // Platform will do nothing; Homebridge still loads cleanly.
      this.client = new EagleClient('', '', '', log);
      this.pollIntervalMs = MIN_POLL_INTERVAL * 1000;
      this.showExportMeter = false;
      this.meterName = 'Grid Meter';
      this.exportMeterName = 'Grid Meter - Export';
      this.matterEnabled = false;
      return;
    }

    const host = eagleConfig.host || `eagle-${eagleConfig.cloudId}.local`;
    if (!eagleConfig.host) {
      this.log.info(`No host configured — using mDNS default: ${host}`);
    }

    let pollInterval = eagleConfig.pollInterval ?? 15;
    if (pollInterval < MIN_POLL_INTERVAL) {
      this.log.warn(
        `pollInterval ${pollInterval}s is below minimum; clamping to ${MIN_POLL_INTERVAL}s`,
      );
      pollInterval = MIN_POLL_INTERVAL;
    }
    this.pollIntervalMs = pollInterval * 1000;
    this.showExportMeter = eagleConfig.showExportMeter ?? false;
    this.exportMeterName = eagleConfig.exportMeterName ?? 'Grid Meter - Export';
    this.meterName = eagleConfig.meterName ?? (this.showExportMeter ? 'Grid Meter - Import' : 'Grid Meter');
    this.matterEnabled = eagleConfig.matter === true;

    this.client = new EagleClient(
      host,
      eagleConfig.cloudId,
      eagleConfig.installCode,
      log,
    );

    this.log.info('Finished initializing platform:', config.name ?? PLATFORM_NAME);

    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching — starting device discovery');
      this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private discoverDevices(): void {
    this.client
      .discoverMeter()
      .then((address) => {
        this.log.info(`Meter discovered at hardware address: ${address}`);
        this.registerOrRestoreAccessory(address);
        this.startPolling(address);
      })
      .catch((err: Error) => {
        const isNoMeter = err.message.includes('No electric_meter');
        const retryMs = isNoMeter ? NO_METER_RETRY_MS : DISCOVER_RETRY_MS;
        this.log.warn(`Device discovery failed: ${err.message}. Retrying in ${retryMs / 1000}s`);
        setTimeout(() => this.discoverDevices(), retryMs);
      });
  }

  private registerOrRestoreAccessory(meterAddress: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const FakeGatoHistoryService = require('fakegato-history')(this.api);

    // --- Import meter ---
    const importUuid = this.api.hap.uuid.generate(meterAddress);
    const existingImport = this.accessories.find((a) => a.UUID === importUuid);

    if (existingImport) {
      this.log.info('Restoring import meter accessory from cache:', existingImport.displayName);
      existingImport.displayName = this.meterName;
      this.api.updatePlatformAccessories([existingImport]);
      this.gridMeterAccessory = new GridMeterAccessory(
        this, existingImport, FakeGatoHistoryService, meterAddress,
      );
    } else {
      this.log.info('Registering new import meter accessory:', this.meterName);
      const accessory = new this.api.platformAccessory(this.meterName, importUuid);
      this.gridMeterAccessory = new GridMeterAccessory(
        this, accessory, FakeGatoHistoryService, meterAddress,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
    }

    // --- Export meter ---
    const exportUuid = this.api.hap.uuid.generate(meterAddress + '-export');
    const existingExport = this.accessories.find((a) => a.UUID === exportUuid);

    if (this.showExportMeter) {
      if (existingExport) {
        this.log.info('Restoring export meter accessory from cache:', existingExport.displayName);
        existingExport.displayName = this.exportMeterName;
        this.api.updatePlatformAccessories([existingExport]);
        this.exportMeterAccessory = new ExportMeterAccessory(
          this, existingExport, FakeGatoHistoryService, meterAddress,
        );
      } else {
        this.log.info('Registering new export meter accessory:', this.exportMeterName);
        const accessory = new this.api.platformAccessory(this.exportMeterName, exportUuid);
        this.exportMeterAccessory = new ExportMeterAccessory(
          this, accessory, FakeGatoHistoryService, meterAddress,
        );
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    } else if (existingExport) {
      // showExportMeter was disabled — remove the stale cached accessory
      this.log.info('Removing stale export meter accessory');
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingExport]);
    }

    // --- Matter (optional) ---
    // Independent of showExportMeter: the grid meter is bidirectional on the
    // Matter side regardless of whether Import/Export are split into two
    // HomeKit/Eve accessories.
    if (this.matterEnabled) {
      const bridge = new MatterEnergyBridge(this.api, this.log, 'bidirectional');
      if (bridge.isSupported()) {
        this.gridMatterBridge = bridge;
        bridge.register(`${meterAddress}-grid-net`, 'Grid', meterAddress.replace(/^0x/i, ''), {
          powerW: 0,
          importedEnergyKWh: 0,
          exportedEnergyKWh: 0,
        }).catch(() => {});
      } else {
        this.log.info('[matter] Config option "matter" is enabled, but the Matter API is unavailable. It needs a Homebridge build with the ElectricalSensor device type, with Matter enabled on this plugin\'s child bridge. Continuing with HomeKit/Eve only.');
      }
    }
  }

  private startPolling(meterAddress: string): void {
    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight) {
        this.log.debug('Poll skipped — previous request still in flight');
        return;
      }
      if (this.backedOff) {
        this.log.debug('Poll skipped — in backoff period');
        return;
      }

      this.pollInFlight = true;
      try {
        const reading = await this.client.queryMeter(meterAddress);
        this.gridMeterAccessory?.updateValues(reading);
        this.exportMeterAccessory?.updateValues(reading);
        this.gridMatterBridge?.update({
          powerW: reading.demand_kw * 1000,
          importedEnergyKWh: reading.summation_delivered_kwh,
          exportedEnergyKWh: reading.summation_received_kwh ?? 0,
        }).catch(() => {});
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.statusCode === 401) {
            this.log.error(
              'HTTP 401 Unauthorized — check cloudId and installCode. Backing off 60s.',
            );
            this.enterBackoff(AUTH_BACKOFF_MS);
          } else if (err.statusCode >= 500) {
            this.log.warn(
              `HTTP ${err.statusCode} from EAGLE — device overloaded. Skipping cycle.`,
            );
          } else {
            this.log.warn(`Poll HTTP error: ${err.message}`);
          }
        } else if (err instanceof Error) {
          if (err.message.includes("not Connected")) {
            this.log.warn(`Meter not connected to ZigBee network — skipping cycle (${err.message})`);
          } else if (err.message.includes('timeout')) {
            this.log.warn('Poll timed out after 10s — skipping cycle');
          } else {
            this.log.warn(`Poll error: ${err.message}`);
          }
        }
      } finally {
        this.pollInFlight = false;
      }
    }, this.pollIntervalMs);
  }

  private enterBackoff(durationMs: number): void {
    this.backedOff = true;
    setTimeout(() => {
      this.backedOff = false;
      this.log.info('Backoff period ended — resuming polls');
    }, durationMs);
  }
}
