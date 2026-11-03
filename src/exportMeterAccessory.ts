import { PlatformAccessory, Service } from 'homebridge';
import { EAGLEPlatform } from './platform';
import { MeterReading } from './eagleClient';
import { EVE_ENERGY_SERVICE_UUID, setEveNotify } from './eveCharacteristics';
import { PowerSwitch } from './powerSwitch';

export class ExportMeterAccessory {
  private readonly eveEnergyService: Service;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly historyService: any;

  private lastExportW = 0;
  private lastReceivedKwh = 0;
  private readonly key: string;
  private readonly powerSwitch: PowerSwitch;

  constructor(
    private readonly platform: EAGLEPlatform,
    accessory: PlatformAccessory,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    FakeGatoHistoryService: any,
    meterAddress: string,
  ) {
    const { Characteristic, api } = platform;
    const { EveWatts, EveKWh } = platform.eveChars;
    this.key = `export:${accessory.displayName}`;
    this.powerSwitch = platform.createPowerSwitch(this.key);

    const infoService =
      accessory.getService(platform.Service.AccessoryInformation) ??
      accessory.addService(platform.Service.AccessoryInformation);

    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Rainforest Automation')
      .setCharacteristic(Characteristic.Model, 'EAGLE-200')
      .setCharacteristic(Characteristic.SerialNumber, meterAddress.replace(/^0x/i, ''));

    const existingService = accessory.services.find(s => s.UUID === EVE_ENERGY_SERVICE_UUID);
    if (existingService) {
      this.eveEnergyService = existingService;
    } else {
      this.eveEnergyService = accessory.addService(
        new api.hap.Service(platform.exportMeterName, EVE_ENERGY_SERVICE_UUID),
      );
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
    setEveNotify(this.eveEnergyService.getCharacteristic(EveWatts), platform.eveThrottle.notify);

    this.eveEnergyService
      .getCharacteristic(EveKWh)
      .onGet(() => this.lastReceivedKwh);
    setEveNotify(this.eveEnergyService.getCharacteristic(EveKWh), platform.eveThrottle.notify);

    this.historyService = new FakeGatoHistoryService('energy', accessory, {
      storage: 'fs',
    });
  }

  updateValues(reading: MeterReading): void {
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
