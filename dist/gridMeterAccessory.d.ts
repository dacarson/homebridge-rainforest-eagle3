import { PlatformAccessory } from 'homebridge';
import { EAGLEPlatform } from './platform';
import { MeterReading } from './eagleClient';
export declare class GridMeterAccessory {
    private readonly platform;
    private readonly eveEnergyService;
    private readonly historyService;
    private lastDemandW;
    private lastDeliveredKwh;
    constructor(platform: EAGLEPlatform, accessory: PlatformAccessory, FakeGatoHistoryService: any);
    updateValues(reading: MeterReading): void;
}
//# sourceMappingURL=gridMeterAccessory.d.ts.map