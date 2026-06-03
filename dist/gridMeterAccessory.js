"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GridMeterAccessory = void 0;
const eveCharacteristics_1 = require("./eveCharacteristics");
class GridMeterAccessory {
    constructor(platform, accessory, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FakeGatoHistoryService) {
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
            .setCharacteristic(Characteristic.SerialNumber, accessory.UUID);
        // Eve Energy service: look up by UUID string, create by passing an instance to addService.
        // getService(string) matches by UUID internally in hap-nodejs.
        const existingService = accessory.getService(eveCharacteristics_1.EVE_ENERGY_SERVICE_UUID);
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
        // Eve Watt (custom characteristic — add instance, then look up by UUID string)
        this.eveEnergyService.addCharacteristic(new EveWatts());
        this.eveEnergyService
            .getCharacteristic(eveCharacteristics_1.EVE_WATT_UUID)
            ?.onGet(() => this.lastDemandW);
        // Eve kWh (custom characteristic)
        this.eveEnergyService.addCharacteristic(new EveKWh());
        this.eveEnergyService
            .getCharacteristic(eveCharacteristics_1.EVE_KWH_UUID)
            ?.onGet(() => this.lastDeliveredKwh);
        // fakegato-history: 'energy' type logs { time, power } in Watts
        this.historyService = new FakeGatoHistoryService('energy', accessory, {
            storage: 'fs',
        });
    }
    updateValues(reading) {
        const { Characteristic } = this.platform;
        this.lastDemandW = Math.round(reading.demand_kw * 1000 * 10) / 10;
        this.lastDeliveredKwh = reading.summation_delivered_kwh;
        this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastDemandW > 0);
        this.eveEnergyService.updateCharacteristic(Characteristic.OutletInUse, true);
        this.eveEnergyService.updateCharacteristic(eveCharacteristics_1.EVE_WATT_UUID, this.lastDemandW);
        this.eveEnergyService.updateCharacteristic(eveCharacteristics_1.EVE_KWH_UUID, this.lastDeliveredKwh);
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