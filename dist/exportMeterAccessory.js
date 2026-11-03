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
        this.key = `export:${accessory.displayName}`;
        this.powerSwitch = platform.createPowerSwitch(this.key);
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
        // On — true when exporting to the grid (deadband + hold, see powerSwitch.ts)
        this.eveEnergyService
            .getCharacteristic(Characteristic.On)
            .onGet(() => this.powerSwitch.state)
            .onSet(async () => {
            this.eveEnergyService.updateCharacteristic(Characteristic.On, this.powerSwitch.state);
        });
        this.eveEnergyService
            .getCharacteristic(Characteristic.OutletInUse)
            .onGet(() => true);
        this.eveEnergyService
            .getCharacteristic(EveWatts)
            .onGet(() => this.lastExportW);
        (0, eveCharacteristics_1.setEveNotify)(this.eveEnergyService.getCharacteristic(EveWatts), platform.eveThrottle.notify);
        this.eveEnergyService
            .getCharacteristic(EveKWh)
            .onGet(() => this.lastReceivedKwh);
        (0, eveCharacteristics_1.setEveNotify)(this.eveEnergyService.getCharacteristic(EveKWh), platform.eveThrottle.notify);
        this.historyService = new FakeGatoHistoryService('energy', accessory, {
            storage: 'fs',
        });
    }
    updateValues(reading) {
        const { Characteristic } = this.platform;
        const { EveWatts, EveKWh } = this.platform.eveChars;
        this.lastExportW = Math.round(Math.max(0, -reading.demand_kw) * 1000 * 10) / 10;
        this.lastReceivedKwh = reading.summation_received_kwh ?? 0;
        const on = this.powerSwitch.update(this.lastExportW);
        if (on !== null) {
            this.eveEnergyService.updateCharacteristic(Characteristic.On, on);
        }
        this.eveEnergyService.updateCharacteristic(Characteristic.OutletInUse, true);
        this.platform.updateEve(this.eveEnergyService, EveWatts, `${this.key}:EveWatts`, this.lastExportW, 'W');
        this.platform.updateEve(this.eveEnergyService, EveKWh, `${this.key}:EveKWh`, this.lastReceivedKwh, 'kWh');
        this.historyService.addEntry({
            time: Math.round(Date.now() / 1000),
            power: this.lastExportW,
        });
    }
}
exports.ExportMeterAccessory = ExportMeterAccessory;
//# sourceMappingURL=exportMeterAccessory.js.map