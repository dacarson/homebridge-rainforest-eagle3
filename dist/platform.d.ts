import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { EveChars } from './eveCharacteristics';
export declare class EAGLEPlatform implements DynamicPlatformPlugin {
    readonly log: Logger;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    readonly accessories: PlatformAccessory[];
    readonly eveChars: EveChars;
    readonly meterName: string;
    readonly showExportMeter: boolean;
    readonly exportMeterName: string;
    private readonly client;
    private readonly pollIntervalMs;
    private gridMeterAccessory?;
    private exportMeterAccessory?;
    private pollTimer?;
    private pollInFlight;
    private backedOff;
    constructor(log: Logger, config: PlatformConfig, api: API);
    configureAccessory(accessory: PlatformAccessory): void;
    private discoverDevices;
    private registerOrRestoreAccessory;
    private startPolling;
    private enterBackoff;
}
//# sourceMappingURL=platform.d.ts.map