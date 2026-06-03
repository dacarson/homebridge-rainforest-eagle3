import { PlatformConfig } from 'homebridge';
export declare const PLATFORM_NAME = "EAGLE";
export declare const PLUGIN_NAME = "homebridge-rainforest-eagle3";
export interface EAGLEConfig extends PlatformConfig {
    host: string;
    cloudId: string;
    installCode: string;
    pollInterval?: number;
    meterName?: string;
}
//# sourceMappingURL=settings.d.ts.map