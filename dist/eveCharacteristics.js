"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVE_KWH_UUID = exports.EVE_WATT_UUID = exports.EVE_ENERGY_SERVICE_UUID = void 0;
exports.createEveCharacteristics = createEveCharacteristics;
exports.EVE_ENERGY_SERVICE_UUID = 'E863F10A-079E-48FF-8F27-9C2605A29F52';
exports.EVE_WATT_UUID = 'E863F10D-079E-48FF-8F27-9C2605A29F52';
exports.EVE_KWH_UUID = 'E863F10C-079E-48FF-8F27-9C2605A29F52';
function createEveCharacteristics(api) {
    const hap = api.hap;
    class EveWatts extends hap.Characteristic {
        constructor() {
            super('Eve Watts', EveWatts.UUID, {
                format: "float" /* Formats.FLOAT */,
                unit: 'W',
                minValue: 0,
                maxValue: 100000,
                minStep: 0.1,
                perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
            });
            this.value = this.getDefaultValue();
        }
    }
    EveWatts.UUID = exports.EVE_WATT_UUID;
    class EveKWh extends hap.Characteristic {
        constructor() {
            super('Eve kWh', EveKWh.UUID, {
                format: "float" /* Formats.FLOAT */,
                unit: 'kWh',
                minValue: 0,
                maxValue: 1000000,
                minStep: 0.001,
                perms: ["pr" /* Perms.PAIRED_READ */, "ev" /* Perms.NOTIFY */],
            });
            this.value = this.getDefaultValue();
        }
    }
    EveKWh.UUID = exports.EVE_KWH_UUID;
    return {
        EveWatts: EveWatts,
        EveKWh: EveKWh,
    };
}
//# sourceMappingURL=eveCharacteristics.js.map