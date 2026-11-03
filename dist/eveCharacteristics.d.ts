import { API, Characteristic } from 'homebridge';
export declare const EVE_ENERGY_SERVICE_UUID = "E863F10A-079E-48FF-8F27-9C2605A29F52";
export declare const EVE_WATT_UUID = "E863F10D-079E-48FF-8F27-9C2605A29F52";
export declare const EVE_KWH_UUID = "E863F10C-079E-48FF-8F27-9C2605A29F52";
export type EveCharClass = {
    new (): Characteristic;
    UUID: string;
};
export interface EveChars {
    EveWatts: EveCharClass;
    EveKWh: EveCharClass;
}
export declare function createEveCharacteristics(api: API): EveChars;
/**
 * Adds or removes NOTIFY on an Eve characteristic. Applied to every instance,
 * including ones restored from the accessory cache (which keep their cached
 * props rather than the class defaults), so switching evePowerUpdates to or
 * from pollOnly takes effect on restart.
 */
export declare function setEveNotify(characteristic: Characteristic, notify: boolean): void;
//# sourceMappingURL=eveCharacteristics.d.ts.map