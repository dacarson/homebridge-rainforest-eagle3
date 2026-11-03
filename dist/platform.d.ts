import { API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import { EveChars } from './eveCharacteristics';
import { EveUnit, EveUpdateThrottle, UpdatePolicyOptions } from './updatePolicy';
import { PowerSwitch } from './powerSwitch';
import { EveCharClass } from './eveCharacteristics';
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
    readonly matterEnabled: boolean;
    readonly updatePolicy: UpdatePolicyOptions;
    readonly eveThrottle: EveUpdateThrottle;
    private readonly switchStats;
    private readonly client;
    private readonly pollIntervalMs;
    private gridMeterAccessory?;
    private exportMeterAccessory?;
    private gridMatterBridge?;
    private pollTimer?;
    private throttleStatsTimer?;
    private pollInFlight;
    private backedOff;
    constructor(log: Logger, config: PlatformConfig, api: API);
    /** Push an Eve power/energy value, subject to the evePowerUpdates mode. */
    updateEve(service: Service, characteristic: EveCharClass, key: string, value: number, unit: EveUnit): void;
    /** On/off state for a power-derived On characteristic, with deadband and hold. */
    createPowerSwitch(key: string): PowerSwitch;
    configureAccessory(accessory: PlatformAccessory): void;
    private discoverDevices;
    private registerOrRestoreAccessory;
    private startPolling;
    private enterBackoff;
}
//# sourceMappingURL=platform.d.ts.map