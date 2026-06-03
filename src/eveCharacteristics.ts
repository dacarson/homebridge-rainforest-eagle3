import { API, Characteristic, Formats, Perms } from 'homebridge';

export const EVE_ENERGY_SERVICE_UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
export const EVE_WATT_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
export const EVE_KWH_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';

// HAP expects characteristic constructors typed as { new(): Characteristic; UUID: string }.
export type EveCharClass = { new(): Characteristic; UUID: string };

export interface EveChars {
  EveWatts: EveCharClass;
  EveKWh: EveCharClass;
}

export function createEveCharacteristics(api: API): EveChars {
  const hap = api.hap;

  class EveWatts extends hap.Characteristic {
    static readonly UUID = EVE_WATT_UUID;

    constructor() {
      super('Eve Watts', EveWatts.UUID, {
        format: Formats.FLOAT,
        unit: 'W' as string,
        minValue: -100000,
        maxValue: 100000,
        minStep: 0.1,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  class EveKWh extends hap.Characteristic {
    static readonly UUID = EVE_KWH_UUID;

    constructor() {
      super('Eve kWh', EveKWh.UUID, {
        format: Formats.FLOAT,
        unit: 'kWh' as string,
        minValue: 0,
        maxValue: 1000000,
        minStep: 0.001,
        perms: [Perms.PAIRED_READ, Perms.NOTIFY],
      });
      this.value = this.getDefaultValue();
    }
  }

  return {
    EveWatts: EveWatts as unknown as EveCharClass,
    EveKWh: EveKWh as unknown as EveCharClass,
  };
}
