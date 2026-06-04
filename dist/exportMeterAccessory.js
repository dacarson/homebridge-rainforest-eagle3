"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExportMeterAccessory = void 0;
const eveCharacteristics_1 = require("./eveCharacteristics");
class ExportMeterAccessory {
    constructor(platform, accessory, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FakeGatoHistoryService, meterAddress) {
        this.platform = platform;
        this.lastExportW = 0;
        this.lastReceivedKwh = 0;
        const { Characteristic, api } = platform;
        const { EveWatts, EveKWh } = platform.eveChars;
        const infoService = accessory.getService(platform.Service.AccessoryInformation) ??
            accessory.addService(platform.Service.AccessoryInformation);
        infoService
            .setCharacteristic(Characteristic.Manufacturer, 'Rainforest Automation')
            .setCharacteristic(Characteristic.Model, 'EAGLE-200')
            .setCharacteristic(Characteristic.SerialNumber, meterAddress.replace(/^0x/i, ''));
        const existingService = accessory.services.find(s => s.UUID === eveCharacteristics_1.EVE_ENERGY_SERVICE_UUID);
        if (existingService) {
            this.eveEnergyService = existingService;
        }
        else {
            this.eveEnergyService = accessory.addService(new api.hap.Service(platform.exportMeterName, eveCharacteristics_1.EVE_ENERGY_SERVICE_UUID));
        }
        this.eveEnergyService.setCharacteristic(Characteristic.Name, platform.exportMeterName);
        // On — true when the home is actively exporting to the grid
        this.eveEnergyService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.lastExportW > 0)
            .onSet(async () => {
            this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastExportW > 0);
        });
        this.eveEnergyService
            .getCharacteristic(Characteristic.OutletInUse)
            .onGet(() => true);
        this.eveEnergyService
            .getCharacteristic(EveWatts)
            .onGet(() => this.lastExportW);
        this.eveEnergyService
            .getCharacteristic(EveKWh)
            .onGet(() => this.lastReceivedKwh);
        this.historyService = new FakeGatoHistoryService('energy', accessory, {
            storage: 'fs',
        });
    }
    updateValues(reading) {
        const { Characteristic } = this.platform;
        const { EveWatts, EveKWh } = this.platform.eveChars;
        this.lastExportW = Math.round(Math.max(0, -reading.demand_kw) * 1000 * 10) / 10;
        this.lastReceivedKwh = reading.summation_received_kwh ?? 0;
        this.eveEnergyService.updateCharacteristic(Characteristic.On, this.lastExportW > 0);
        this.eveEnergyService.updateCharacteristic(Characteristic.OutletInUse, true);
        this.eveEnergyService.updateCharacteristic(EveWatts, this.lastExportW);
        this.eveEnergyService.updateCharacteristic(EveKWh, this.lastReceivedKwh);
        this.historyService.addEntry({
            time: Math.round(Date.now() / 1000),
            power: this.lastExportW,
        });
    }
}
exports.ExportMeterAccessory = ExportMeterAccessory;
//# sourceMappingURL=exportMeterAccessory.js.map