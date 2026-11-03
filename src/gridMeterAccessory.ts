import { PlatformAccessory, Service } from 'homebridge';
import { EAGLEPlatform } from './platform';
import { MeterReading } from './eagleClient';
import { EVE_ENERGY_SERVICE_UUID, setEveNotify } from './eveCharacteristics';
import { PowerSwitch } from './powerSwitch';

export class GridMeterAccessory {
  private readonly eveEnergyService: Service;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly historyService: any;

  private lastDemandW = 0;
  private lastDeliveredKwh = 0;
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
    this.key = `import:${accessory.displayName}`;
    this.powerSwitch = platform.createPowerSwitch(this.key);

    // Accessory information service
    const infoService =
      accessory.getService(platform.Service.AccessoryInformation) ??
      accessory.addService(platform.Service.AccessoryInformation);

    infoService
      .setCharacteristic(Characteristic.Manufacturer, 'Rainforest Automation')
      .setCharacteristic(Characteristic.Model, 'EAGLE-200')
      .setCharacteristic(Characteristic.SerialNumber, meterAddress.replace(/^0x/i, ''));

    // getService(string) in hap-nodejs matches by displayName/name/subtype, NOT by UUID.
    // Use services.find() to reliably look up by UUID from cache.
    const existingService = accessory.services.find(s => s.UUID === EVE_ENERGY_SERVICE_UUID);
    if (existingService) {
      this.eveEnergyService = existingService;
    } else {
      this.eveEnergyService = accessory.addService(
        new api.hap.Service(platform.meterName, EVE_ENERGY_SERVICE_UUID),
      );
    }

    this.eveEnergyService.setCharacteristic(Characteristic.Name, platform.meterName);

    // On — true when importing from the grid (deadband + hold, see powerSwitch.ts)
    this.eveEnergyService
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.powerSwitch.state)
      .onSet(async () => {
        // Read-only: revert to polled state immediately
        this.eveEnergyService.updateCharacteristic(Characteristic.On, this.powerSwitch.state);
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
    setEveNotify(this.eveEnergyService.getCharacteristic(EveWatts), platform.eveThrottle.notify);

    this.eveEnergyService
      .getCharacteristic(EveKWh)
      .onGet(() => this.lastDeliveredKwh);
    setEveNotify(this.eveEnergyService.getCharacteristic(EveKWh), platform.eveThrottle.notify);

    // fakegato-history: 'energy' type logs { time, power } in Watts
    this.historyService = new FakeGatoHistoryService('energy', accessory, {
      storage: 'fs',
    });
  }

  updateValues(reading: MeterReading): void {
    const { Characteristic } = this.platform;
    const { EveWatts, EveKWh } = this.platform.eveChars;

    this.lastDemandW = Math.round(Math.max(0, reading.demand_kw) * 1000 * 10) / 10;
    this.lastDeliveredKwh = reading.summation_delivered_kwh;

    const on = this.powerSwitch.update(this.lastDemandW);
    if (on !== null) {
      this.eveEnergyService.updateCharacteristic(Characteristic.On, on);
    }
    this.eveEnergyService.updateCharacteristic(Characteristic.OutletInUse, true);
    this.platform.updateEve(this.eveEnergyService, EveWatts, `${this.key}:EveWatts`, this.lastDemandW, 'W');
    this.platform.updateEve(this.eveEnergyService, EveKWh, `${this.key}:EveKWh`, this.lastDeliveredKwh, 'kWh');

    this.historyService.addEntry({
      time: Math.round(Date.now() / 1000),
      power: this.lastDemandW,
    });

    this.platform.log.debug(
      `Updated: demand=${this.lastDemandW}W, delivered=${this.lastDeliveredKwh}kWh` +
        (reading.summation_received_kwh !== undefined
          ? `, received=${reading.summation_received_kwh}kWh`
          : ''),
    );
  }
}
