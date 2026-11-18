# Eve Energy history (fakegato-history): known problems and fixes

Audience: an AI coding assistant working on a Homebridge plugin that uses
`fakegato-history` with the `'energy'` type (Eve Energy history). Read this before
changing how the plugin records history, and use the audit checklist to check an
existing plugin.

Source of the findings: the homebridge-openevse plugin (an EV charger at about 9.2 kW),
checked against the Eve iOS app on 2026-11-18. The rules for how Eve calculates energy
were worked out from the values the app showed; they aren't documented anywhere.

## TL;DR

1. **Power is a 16-bit unsigned field holding watts × 10.** Anything above **6553.5 W**
   wraps around silently (9183 W is stored as about 2630 W). Cap it; don't let it wrap.
2. **Eve calculates an entry's energy as `power × min(time since the previous entry, 600 s)`.**
   Entries are not fixed 10-minute samples. So:
   - Splitting one period into several entries **does not** get past the cap. Entries
     close together get almost no time, so they add almost no energy.
   - Changing how often you write entries **does not** change the total. Over any span,
     Eve's energy is at most 6553.5 W × that span.
   - The only way around the cap is fake timestamps, which push the timeline into the
     future. Don't do it.
3. **The energy record has a temperature slot that fakegato always fills with 0.** If the
   accessory also has a `CurrentTemperature` characteristic (for example a
   TemperatureSensor service on the same accessory), Eve draws a temperature history
   graph stuck at **0 °C / 32 °F**. Fill the slot with the real temperature.
4. **Write one entry every 10 minutes**, with the average power over that window weighted
   by time. Not on every poll, and not fakegato's own timer, which averages raw samples
   without weighting by time.
5. **Upgrading users clear bad history in the Eve app** (history list → **Edit**). Don't
   reset fakegato's stored history file: see "Clearing bad history" below.

## When this applies

- Any plugin that calls `new FakeGatoHistoryService('energy', accessory, ...)`.
- **Power cap:** the device can draw more than 6.5 kW. Examples: EV chargers (7.7 kW at
  32 A, 9.6 kW at 40 A, 11.5 kW at 48 A, 19.2 kW at 80 A), whole-home or circuit meters,
  heat pumps, solar inverters reporting production.
- **Temperature slot:** the accessory with the history service also has a
  `CurrentTemperature` characteristic, on any of its services.

## How the record is laid out

fakegato-history 0.6.x, `getCurrentS2R2`, `TYPE_ENERGY`:

```js
",14 %s%s-%s:0000 0000 %s 0000 0000"   // entry#, time offset, mask 1f, power*10
```

The signature it reports (on the history status characteristic, `S2R1`) is
`04 0102 0202 0702 0f03`: 0102 is temperature, 0202 humidity, 0702 power.

The binary record is 20 bytes (0x14), little-endian:

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | length = 0x14 |
| 1 | 4 | entry number (uint32 LE) |
| 5 | 4 | seconds since the reference time (uint32 LE) |
| 9 | 1 | field mask = 0x1f |
| 10 | 2 | **temperature × 100** (int16 LE). fakegato always writes 0000 |
| 12 | 2 | humidity × 100. Always 0000 |
| 14 | 2 | **power × 10** (uint16 LE). Written as `swap16(power*10)`: wraps above 65535 |
| 16 | 4 | unused, 0000 0000 |

The history stream sent to Eve also contains 0x15 (21-byte) reference-time records.
Use each record's length byte to step through the stream, and only touch records where
length is 0x14 and the mask is 0x1f. A chunk of just `00` means no more entries.

## What we observed in Eve

The Total Consumption history list in Eve shows energy (Wh) per entry. These values
narrowed down the rule:

| Situation | Entry | Eve showed | Explanation |
|---|---|---|---|
| Old code, entry every ~30 s, 9.18 kW | wrapped to ~2630 W | 21.95 Wh | 2630 W × 30 s |
| Split into 3 entries 1 s apart, ~3061 W each | 1st (598 s since previous) | 508.48 Wh | 3061 W × 598 s |
| | 2nd and 3rd (1 s) | 0.85 Wh each | 3061 W × 1 s |
| One entry per 10 min, capped | 6553.5 W | 1092.25 Wh | 6553.5 W × 600 s |
| First entry after a 16-minute gap (restart) | 6553.5 W | 1092.25 Wh | gap counted as only 600 s |

So Eve calculates each entry as `power × min(time since the previous entry, 600 s)`, and
the field is unsigned: 6553.5 W did not show as a negative value.

Don't confuse this with a "power ÷ 6 per entry" rule. The values Eve shows are rounded
to 2 decimals, so almost any of them, multiplied back, lands on a whole number of tenths
of a watt. Those round numbers fit the wrong rule by coincidence; the gaps between
entries are what settle it.

## The fix

The full working implementation is in homebridge-openevse: `src/eveHistory.ts`,
`src/accessory.ts`, and `test/eveHistory.test.ts` (on GitHub at
dacarson/homebridge-openevse). It has three parts.

### 1. Record a time-weighted average every 10 minutes, capped

```ts
export const EVE_HISTORY_INTERVAL_MS = 10 * 60 * 1000;
export const EVE_HISTORY_MAX_POWER_W = 6553.5;          // uint16 / 10
export const EVE_HISTORY_MAX_GAP_MS = 2 * 60 * 1000;     // don't credit outages

export class EveEnergyHistory {
  private energyWs = 0;
  private lastPowerW = 0;
  private lastSampleMs: number | null = null;
  private windowStartMs: number | null = null;

  sample(powerW: number, nowMs: number): void {           // call on every poll/push
    this.integrateTo(nowMs);
    this.lastPowerW = Number.isFinite(powerW) && powerW > 0 ? powerW : 0;
  }

  flush(nowMs: number): { powerW: number; averageW: number } {  // call every 10 min
    this.integrateTo(nowMs);
    const seconds = (nowMs - (this.windowStartMs ?? nowMs)) / 1000;
    const averageW = seconds > 0 ? this.energyWs / seconds : 0;
    this.energyWs = 0;
    this.windowStartMs = nowMs;
    const r = Math.round(averageW * 10) / 10;
    return { powerW: Math.min(EVE_HISTORY_MAX_POWER_W, r), averageW: r };
  }

  private integrateTo(nowMs: number): void {
    if (this.windowStartMs === null) this.windowStartMs = nowMs;
    if (this.lastSampleMs !== null && nowMs > this.lastSampleMs) {
      const dt = Math.min(nowMs - this.lastSampleMs, EVE_HISTORY_MAX_GAP_MS);
      this.energyWs += this.lastPowerW * dt / 1000;
    }
    if (this.lastSampleMs === null || nowMs > this.lastSampleMs) this.lastSampleMs = nowMs;
  }
}
```

Wiring:
- Create the history service with `disableTimer: true`. Call `sample()` from every
  status update.
- Call `sample(0, now)` when the device stops responding.
- Run `setInterval(record, EVE_HISTORY_INTERVAL_MS)`. Call `unref()` on it, and clear it
  on Homebridge's `shutdown` event.
- In `record()`, add one entry with `time: Math.round(now / 1000)`.
- When `averageW > powerW`, log once that history is capped.

### 2. Keep temperature with each entry

For `'energy'`, fakegato's public `addEntry` keeps only `{time, power}`. To store the
temperature too, call the internal `_addEntry`, which also saves it to fakegato's file:

```ts
interface FakeGatoInternals {
  _addEntry(entry: { time: number; power: number; temp?: number }): void;
  getCurrentS2R2(cb: (err: unknown, value?: string) => void): void;
  history: Array<{ temp?: number } | undefined>;
  memorySize: number;
}
(history as unknown as FakeGatoInternals)._addEntry({ time, power, temp: lastTempC });
```

This is equivalent to `addEntry` when `disableTimer` is true.

### 3. Fill the temperature into the records sent to Eve

fakegato attaches its read handler to the `S2R2` characteristic
(`E863F117-079E-48FF-8F27-9C2605A29F52`, on the service `E863F007-...`) with
`.on('get', ...)` in its constructor. Replace that handler with one that patches the
output:

```ts
const char = accessory.services.find(s => s.UUID === 'E863F007-079E-48FF-8F27-9C2605A29F52')
  ?.characteristics.find(c => c.UUID === 'E863F117-079E-48FF-8F27-9C2605A29F52');
const tempFor = (entry: number) => internals.history[entry % internals.memorySize]?.temp;
char.removeAllListeners('get');
char.on('get', cb => internals.getCurrentS2R2((err, value) => {
  if (err || typeof value !== 'string') return cb(err as Error | null, value);
  try { cb(null, fillEnergyHistoryTemperatures(value, tempFor)); } catch { cb(null, value); }
}));

export function fillEnergyHistoryTemperatures(
  base64: string, tempForEntry: (entry: number) => number | undefined,
): string {
  const buf = Buffer.from(base64, 'base64');
  let changed = false;
  for (let pos = 0; pos < buf.length;) {
    const len = buf[pos];
    if (len === 0 || pos + len > buf.length) break;
    if (len === 0x14 && buf[pos + 9] === 0x1f) {
      const t = tempForEntry(buf.readUInt32LE(pos + 1));
      if (t !== undefined && Number.isFinite(t)) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(t * 100))), pos + 10);
        changed = true;
      }
    }
    pos += len;
  }
  return changed ? buf.toString('base64') : base64;
}
```

Only install this wrapper when the accessory actually has a temperature
characteristic. Entries recorded before the change have no stored temperature and stay
at 0.

## Clearing bad history

- **Don't** delete or rename fakegato's stored history file
  (`<storagePath>/<hostname>_<accessoryName>_persist.json`) to "reset" history. Eve
  remembers the last entry number it downloaded and asks only for entries after it.
  fakegato's entry numbers keep counting up and never wrap. A fresh history file starts
  again at 1, so Eve would likely see nothing new until the count catches up.
- **Do** tell users, in the CHANGELOG and README, to clear the old entries in the Eve app
  (history list → **Edit**). We checked that new 10-minute entries keep arriving
  afterwards. The bad entries left in fakegato's file roll out of its buffer
  (4032 entries is about 28 days at 10-minute spacing). They only come back if Eve
  downloads the whole history again, for example on a new phone.

## What the user should be told (README)

- Eve's history graph and history kWh are capped at 6.5 kW. Give the shortfall for
  typical loads: 7.7 kW about 15%, 9.6 kW about 32%, 11.5 kW about 43%,
  19.2 kW about 66%.
- These are **not** capped: the live `Consumption` (E863F10D) and `Total Consumption`
  (E863F10C) characteristics are floats, and Matter/Apple Home Energy has its own
  values. Point users to those for accurate totals.

## Audit checklist for an existing plugin

- [ ] Does the plugin use `FakeGatoHistoryService('energy', ...)`?
- [ ] Can `power` passed to `addEntry` exceed 6553.5 W? If so, it's wrapping today.
- [ ] How often are entries written? Every poll is wasteful, and each entry's energy
      depends on the gap since the previous one. Switch to 10-minute time-weighted
      averages.
- [ ] Does the plugin use fakegato's timer (`disableTimer` false)? It averages samples
      by count, not by time. Prefer the approach above.
- [ ] Does the same accessory have `CurrentTemperature`? If so, Eve shows a 0 °C history
      graph until you apply fix 3.
- [ ] Do the README and CHANGELOG cover the cap and the Eve **Edit** cleanup?
- [ ] Tests: averaging, the cap (`powerW * 10 <= 0xffff`), window edges, the outage gap
      limit, and record patching (0x15 records untouched, `00` terminator handled).
- [ ] Pin or check the `fakegato-history` version. Fixes 2 and 3 rely on its internals
      (`_addEntry`, `history`, `memorySize`, `getCurrentS2R2`, and the S2R2 `get`
      listener), verified against 0.6.7.
