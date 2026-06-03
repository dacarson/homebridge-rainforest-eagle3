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
import { createEveCharacteristics, EveChars } from './eveCharacteristics';

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

  private readonly client: EagleClient;
  private readonly pollIntervalMs: number;

  private gridMeterAccessory?: GridMeterAccessory;
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

    if (!eagleConfig.host || !eagleConfig.cloudId || !eagleConfig.installCode) {
      this.log.error('Missing required config: host, cloudId, and installCode are required.');
      // Platform will do nothing; Homebridge still loads cleanly.
      this.client = new EagleClient('', '', '', log);
      this.pollIntervalMs = MIN_POLL_INTERVAL * 1000;
      this.meterName = 'Grid Meter';
      return;
    }

    let pollInterval = eagleConfig.pollInterval ?? 15;
    if (pollInterval < MIN_POLL_INTERVAL) {
      this.log.warn(
        `pollInterval ${pollInterval}s is below minimum; clamping to ${MIN_POLL_INTERVAL}s`,
      );
      pollInterval = MIN_POLL_INTERVAL;
    }
    this.pollIntervalMs = pollInterval * 1000;
    this.meterName = eagleConfig.meterName ?? 'Grid Meter';

    this.client = new EagleClient(
      eagleConfig.host,
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

    const uuid = this.api.hap.uuid.generate(meterAddress);
    const existingAccessory = this.accessories.find((a) => a.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring grid meter accessory from cache:', existingAccessory.displayName);
      existingAccessory.displayName = this.meterName;
      this.api.updatePlatformAccessories([existingAccessory]);
      this.gridMeterAccessory = new GridMeterAccessory(
        this,
        existingAccessory,
        FakeGatoHistoryService,
      );
    } else {
      this.log.info('Registering new grid meter accessory:', this.meterName);
      const accessory = new this.api.platformAccessory(this.meterName, uuid);
      this.gridMeterAccessory = new GridMeterAccessory(
        this,
        accessory,
        FakeGatoHistoryService,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.push(accessory);
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
            this.log.warn(`Meter not connected to ZigBee network — skipping cycle`);
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
