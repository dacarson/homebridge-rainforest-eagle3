# Changelog

## 1.2.1

### Fixed

- **Eve history no longer wraps above 6.5 kW.** Eve stores history power as watts × 10 in a 16-bit field, so a 10-minute average above 6553.5 W wrapped to a much smaller value (for example 9183 W was stored as about 2630 W). History entries are now capped at 6553.5 W, and the plugin logs once when that happens. The live Eve Watts and Eve kWh values and the Matter values are not capped. See [Eve History](README.md#eve-history).
- **Eve history entries are now time-weighted averages.** fakegato's built-in timer averaged readings by count, not by time. The plugin now writes one entry every 10 minutes with the time-weighted average power over those 10 minutes. Gaps from failed polls are left out of the average instead of being counted as the last reading.

### Upgrading

Entries recorded before this version may be wrong if your demand went above 6.5 kW. To remove them, open the meter's consumption history in the Eve app, tap **Edit**, and delete the bad entries. New entries keep arriving afterwards. Don't delete the plugin's fakegato history file (`<storage>/<hostname>_<name>_persist.json`) to reset history: Eve remembers the last entry number it downloaded, and a fresh file starts numbering again from 1, so Eve may show no new history for a long time.

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
