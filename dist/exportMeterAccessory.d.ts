import { PlatformAccessory } from 'homebridge';
import { EAGLEPlatform } from './platform';
import { MeterReading } from './eagleClient';
export declare class ExportMeterAccessory {
    private readonly platform;
    private readonly eveEnergyService;
    private readonly historyService;
    private lastExportW;
    private lastReceivedKwh;
    constructor(platform: EAGLEPlatform, accessory: PlatformAccessory, FakeGatoHistoryService: any, meterAddress: string);
    updateValues(reading: MeterReading): void;
}
//# sourceMappingURL=exportMeterAccessory.d.ts.map