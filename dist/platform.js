"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EAGLEPlatform = void 0;
const settings_1 = require("./settings");
const eagleClient_1 = require("./eagleClient");
const gridMeterAccessory_1 = require("./gridMeterAccessory");
const exportMeterAccessory_1 = require("./exportMeterAccessory");
const eveCharacteristics_1 = require("./eveCharacteristics");
const MIN_POLL_INTERVAL = 5;
const DISCOVER_RETRY_MS = 30000;
const NO_METER_RETRY_MS = 60000;
const AUTH_BACKOFF_MS = 60000;
class EAGLEPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.api = api;
        this.accessories = [];
        this.pollInFlight = false;
        this.backedOff = false;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.eveChars = (0, eveCharacteristics_1.createEveCharacteristics)(api);
        const eagleConfig = config;
        if (!eagleConfig.cloudId || !eagleConfig.installCode) {
            this.log.error('Missing required config: cloudId and installCode are required.');
            // Platform will do nothing; Homebridge still loads cleanly.
            this.client = new eagleClient_1.EagleClient('', '', '', log);
            this.pollIntervalMs = MIN_POLL_INTERVAL * 1000;
            this.showExportMeter = false;
            this.meterName = 'Grid Meter';
            this.exportMeterName = 'Grid Meter - Export';
            return;
        }
        const host = eagleConfig.host || `eagle-${eagleConfig.cloudId}.local`;
        if (!eagleConfig.host) {
            this.log.info(`No host configured — using mDNS default: ${host}`);
        }
        let pollInterval = eagleConfig.pollInterval ?? 15;
        if (pollInterval < MIN_POLL_INTERVAL) {
            this.log.warn(`pollInterval ${pollInterval}s is below minimum; clamping to ${MIN_POLL_INTERVAL}s`);
            pollInterval = MIN_POLL_INTERVAL;
        }
        this.pollIntervalMs = pollInterval * 1000;
        this.showExportMeter = eagleConfig.showExportMeter ?? false;
        this.exportMeterName = eagleConfig.exportMeterName ?? 'Grid Meter - Export';
        this.meterName = eagleConfig.meterName ?? (this.showExportMeter ? 'Grid Meter - Import' : 'Grid Meter');
        this.client = new eagleClient_1.EagleClient(host, eagleConfig.cloudId, eagleConfig.installCode, log);
        this.log.info('Finished initializing platform:', config.name ?? settings_1.PLATFORM_NAME);
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
    configureAccessory(accessory) {
        this.log.info('Loading accessory from cache:', accessory.displayName);
        this.accessories.push(accessory);
    }
    discoverDevices() {
        this.client
            .discoverMeter()
            .then((address) => {
            this.log.info(`Meter discovered at hardware address: ${address}`);
            this.registerOrRestoreAccessory(address);
            this.startPolling(address);
        })
            .catch((err) => {
            const isNoMeter = err.message.includes('No electric_meter');
            const retryMs = isNoMeter ? NO_METER_RETRY_MS : DISCOVER_RETRY_MS;
            this.log.warn(`Device discovery failed: ${err.message}. Retrying in ${retryMs / 1000}s`);
            setTimeout(() => this.discoverDevices(), retryMs);
        });
    }
    registerOrRestoreAccessory(meterAddress) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const FakeGatoHistoryService = require('fakegato-history')(this.api);
        // --- Import meter ---
        const importUuid = this.api.hap.uuid.generate(meterAddress);
        const existingImport = this.accessories.find((a) => a.UUID === importUuid);
        if (existingImport) {
            this.log.info('Restoring import meter accessory from cache:', existingImport.displayName);
            existingImport.displayName = this.meterName;
            this.api.updatePlatformAccessories([existingImport]);
            this.gridMeterAccessory = new gridMeterAccessory_1.GridMeterAccessory(this, existingImport, FakeGatoHistoryService, meterAddress);
        }
        else {
            this.log.info('Registering new import meter accessory:', this.meterName);
            const accessory = new this.api.platformAccessory(this.meterName, importUuid);
            this.gridMeterAccessory = new gridMeterAccessory_1.GridMeterAccessory(this, accessory, FakeGatoHistoryService, meterAddress);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
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
                this.exportMeterAccessory = new exportMeterAccessory_1.ExportMeterAccessory(this, existingExport, FakeGatoHistoryService, meterAddress);
            }
            else {
                this.log.info('Registering new export meter accessory:', this.exportMeterName);
                const accessory = new this.api.platformAccessory(this.exportMeterName, exportUuid);
                this.exportMeterAccessory = new exportMeterAccessory_1.ExportMeterAccessory(this, accessory, FakeGatoHistoryService, meterAddress);
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.accessories.push(accessory);
            }
        }
        else if (existingExport) {
            // showExportMeter was disabled — remove the stale cached accessory
            this.log.info('Removing stale export meter accessory');
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [existingExport]);
        }
    }
    startPolling(meterAddress) {
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
            }
            catch (err) {
                if (err instanceof eagleClient_1.HttpError) {
                    if (err.statusCode === 401) {
                        this.log.error('HTTP 401 Unauthorized — check cloudId and installCode. Backing off 60s.');
                        this.enterBackoff(AUTH_BACKOFF_MS);
                    }
                    else if (err.statusCode >= 500) {
                        this.log.warn(`HTTP ${err.statusCode} from EAGLE — device overloaded. Skipping cycle.`);
                    }
                    else {
                        this.log.warn(`Poll HTTP error: ${err.message}`);
                    }
                }
                else if (err instanceof Error) {
                    if (err.message.includes("not Connected")) {
                        this.log.warn(`Meter not connected to ZigBee network — skipping cycle (${err.message})`);
                    }
                    else if (err.message.includes('timeout')) {
                        this.log.warn('Poll timed out after 10s — skipping cycle');
                    }
                    else {
                        this.log.warn(`Poll error: ${err.message}`);
                    }
                }
            }
            finally {
                this.pollInFlight = false;
            }
        }, this.pollIntervalMs);
    }
    enterBackoff(durationMs) {
        this.backedOff = true;
        setTimeout(() => {
            this.backedOff = false;
            this.log.info('Backoff period ended — resuming polls');
        }, durationMs);
    }
}
exports.EAGLEPlatform = EAGLEPlatform;
//# sourceMappingURL=platform.js.map