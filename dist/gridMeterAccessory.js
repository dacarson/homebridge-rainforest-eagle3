"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GridMeterAccessory = void 0;
const eveCharacteristics_1 = require("./eveCharacteristics");
class GridMeterAccessory {
    constructor(platform, accessory, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FakeGatoHistoryService, meterAddress) {
        this.platform = platform;
        this.lastDemandW = 0;
        this.lastDeliveredKwh = 0;
        const { Characteristic, api } = platform;
        const { EveWatts, EveKWh } = platform.eveChars;
        // Accessory information service
        const infoService = accessory.getService(platform.Service.AccessoryInformation) ??
            accessory.addService(platform.Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Manufacturer, 'Rainforest Automation')
            .setCharacteristic(Characteristic.Model, 'EAGLE-200')
            .setCharacteristic(Characteristic.SerialNumber, meterAddress.replace(/^0x/i, ''));
        // getService(string) in hap-nodejs matches by displayName/name/subtype, NOT by UUID.
        // Use services.find() to reliably look up by UUID from cache.
        const existingService = accessory.services.find(s => s.UUID === eveCharacteristics_1.EVE_ENERGY_SERVICE_UUID);
        if (existingService) {
            this.eveEnergyService = existingService;
        }
        else {
            this.eveEnergyService = accessory.addService(new api.hap.Service(platform.meterName, eveCharacteristics_1.EVE_ENERGY_SERVICE_UUID));
        }
        this.eveEnergyService.setCharacteristic(Characteristic.Name, platform.meterName);
        // On — true when grid is actively being consumed
        this.eveEnergyService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.lastDemandW > 0)
            .onSet(async () => {
            // Read-only: revert to polled state immediately
            this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastDemandW > 0);
        });
        // OutletInUse — always true (required by Eve Energy)
        this.eveEnergyService
            .getCharacteristic(Characteristic.OutletInUse)
            .onGet(() => true);
        // getCharacteristic(class) finds the existing characteristic from cache or adds it if absent —
        // unlike addCharacteristic which always adds and throws on duplicate.
        this.eveEnergyService
            .getCharacteristic(EveWatts)
            .onGet(() => this.lastDemandW);
        this.eveEnergyService
            .getCharacteristic(EveKWh)
            .onGet(() => this.lastDeliveredKwh);
        // fakegato-history: 'energy' type logs { time, power } in Watts
        this.historyService = new FakeGatoHistoryService('energy', accessory, {
            storage: 'fs',
        });
    }
    updateValues(reading) {
        const { Characteristic } = this.platform;
        const { EveWatts, EveKWh } = this.platform.eveChars;
        this.lastDemandW = Math.round(Math.max(0, reading.demand_kw) * 1000 * 10) / 10;
        this.lastDeliveredKwh = reading.summation_delivered_kwh;
        this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastDemandW > 0);
        this.eveEnergyService.updateCharacteristic(Characteristic.OutletInUse, true);
        this.eveEnergyService.updateCharacteristic(EveWatts, this.lastDemandW);
        this.eveEnergyService.updateCharacteristic(EveKWh, this.lastDeliveredKwh);
        this.historyService.addEntry({
            time: Math.round(Date.now() / 1000),
            power: this.lastDemandW,
        });
        this.platform.log.debug(`Updated: demand=${this.lastDemandW}W, delivered=${this.lastDeliveredKwh}kWh` +
            (reading.summation_received_kwh !== undefined
                ? `, received=${reading.summation_received_kwh}kWh`
                : ''));
    }
}
exports.GridMeterAccessory = GridMeterAccessory;
//# sourceMappingURL=gridMeterAccessory.js.map