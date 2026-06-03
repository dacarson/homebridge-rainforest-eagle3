import { Logger } from 'homebridge';
export interface MeterReading {
    demand_kw: number;
    summation_delivered_kwh: number;
    summation_received_kwh?: number;
}
export declare class HttpError extends Error {
    readonly statusCode: number;
    constructor(statusCode: number, message: string);
}
export declare class EagleClient {
    private readonly host;
    private readonly log;
    private readonly auth;
    private readonly parser;
    constructor(host: string, cloudId: string, installCode: string, log: Logger);
    discoverMeter(): Promise<string>;
    queryMeter(meterAddress: string): Promise<MeterReading>;
    private sendCommand;
    private parseValue;
}
//# sourceMappingURL=eagleClient.d.ts.map