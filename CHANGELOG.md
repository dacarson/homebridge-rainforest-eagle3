# Changelog

## 1.2.0

Reduces HomeKit and Matter event traffic. Previously every 15-second poll pushed a new value for each power and energy characteristic, generating hundreds of events an hour.

### Changed defaults

These change behavior for existing installs without any config change. See [HomeKit Updates](README.md#homekit-updates) in the README for details.

- **Eve Watts and Eve kWh are now throttled** (`evePowerUpdates: "throttled"`). They are pushed when Eve Watts changes by at least max(25 W, 2%), when Eve kWh changes by at least 0.1 kWh, or every 5 minutes. Previously every reading was pushed. Eve and Home+ automations on these values keep working, accurate to within those thresholds. Set `evePowerUpdates` to `"live"` for the previous behavior.
- **The On switches now use a deadband and a hold.** Each meter's On switch turns on above 50 W and off below 20 W, where it previously tracked any power above 0 W. A new state must also hold for 60 seconds (`switchHoldSeconds`) before it is reported, so **automations triggered by these switches can fire up to 60 seconds (plus one poll) later than before**. Set `switchHoldSeconds` to `0` to remove the hold. The deadband always applies.

### Added

- `evePowerUpdates` setting: `"throttled"` (default), `"pollOnly"` or `"live"`. `"pollOnly"` removes notify support from the Eve characteristics and never pushes them, for the lowest traffic. Automations triggered by these values stop working in this mode.
- Thresholds for throttled mode: `minChangeWatts`, `minChangePercent`, `minChangeKwh`, `maxIntervalSeconds`.
- `switchHoldSeconds` setting for the On switches.
- Suppressed and held updates are logged at debug level, plus an hourly summary of sent vs. suppressed updates.
- Unit tests (`npm test`).

### Fixed

- The plugin now polls immediately on startup, so HomeKit gets the correct values straight away instead of after the first poll interval.
- Matter: CumulativeEnergyMeasured is only reported when the total changes, or every 15 minutes. PeriodicEnergyMeasured is reported once per 15-minute period, or straight away when energy starts flowing after an idle period. Previously both were recorded on every poll, almost always repeating the previous total or reporting 0 energy.
- Matter: the first periodic energy report no longer claims the meter's entire lifetime total as a single interval.

## 1.1.0

- Optional Matter export of the grid meter for the Apple Home Energy view (`matter`).

## 1.0.0

- Initial release.
