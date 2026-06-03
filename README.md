# homebridge-rainforest-eagle3

A [Homebridge](https://homebridge.io) plugin for the [Rainforest Automation EAGLE-200](https://www.rainforestautomation.com/rfa-z114-eagle-200/) smart meter gateway. Exposes your utility grid meter as an **Eve Energy** accessory in Apple HomeKit, with real-time power demand, cumulative import energy, and native Eve app consumption history.

---

## Features

- Real-time grid demand in Watts (visible in the Eve app and HomeKit detail view)
- Cumulative energy imported (kWh) as a lifetime total
- Up to 7 days of native consumption history in the Eve app via [fakegato-history](https://github.com/simont77/fakegato-history)
- Polls the EAGLE-200 **local** HTTP API — no cloud account or internet required at runtime
- Stateless Basic Auth — no session management, no re-login lifecycle
- Designed to complement [homebridge-pvs6](https://github.com/dacarson/homebridge-pvs6) for a complete solar + grid picture in Apple Home

---

## Supported Hardware

| Device | Status |
|---|---|
| Rainforest EAGLE-200 (RFA-Z114) | Supported |
| Rainforest EAGLE-3 | Expected compatible (uses same local API; unverified) |
| Original EAGLE (Z109) | Not supported — uses a different relay-server API |

---

## How It Works

The EAGLE-200 connects to your utility smart meter over ZigBee (HAN) and exposes live meter data over a local HTTP API. This plugin polls that API every `pollInterval` seconds and publishes the data as a HomeKit accessory. All communication is on your local network — no external services involved.

The accessory renders as a **smart plug** in Apple Home:

- **On** — the outlet is "in use" when the grid is actively delivering power (demand > 0 W)
- **Wattage** — visible in the detail view and in the Eve app
- **Energy history** — the Eve app shows up to 7 days of consumption history

---

## Requirements

- [Homebridge](https://homebridge.io) v1.6 or later
- Node.js 18 or later
- Rainforest EAGLE-200 on the same local network as your Homebridge host
- The EAGLE-200's **Cloud ID** and **Install Code** (printed on the label on the underside of the device)

---

## Installation

Install via the Homebridge UI plugin search, or from the command line:

```bash
npm install -g homebridge-rainforest-eagle3
```

---

## Configuration

Add a platform entry to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "EAGLE",
      "name": "EAGLE",
      "host": "192.168.1.x",
      "cloudId": "004792",
      "installCode": "bfb0fc05f51a3932",
      "pollInterval": 15,
      "meterName": "Grid Meter"
    }
  ]
}
```

### Configuration Options

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | yes | — | Must be `EAGLE` |
| `host` | string | yes | — | IP address or mDNS hostname (e.g. `eagle-004792.local`) of the EAGLE-200 |
| `cloudId` | string | yes | — | Cloud ID from the device label (6 hex characters, upper-left of label) |
| `installCode` | string | yes | — | Install Code from the device label (16 hex characters) |
| `pollInterval` | integer | no | `15` | Seconds between polls. Minimum enforced: `5` |
| `meterName` | string | no | `"Grid Meter"` | Display name for the HomeKit accessory |

### Finding Your Credentials

Flip the EAGLE-200 over and look at the label. You need:

- **Cloud ID** — 6-character hex string in the upper-left (e.g. `004792`)
- **Install Code** — 16-character hex string below the Cloud ID (e.g. `bfb0fc05f51a3932`)

The device is also reachable at `eagle-<cloudId>.local` via mDNS if you prefer not to use a static IP.

---

## HomeKit Accessory

The plugin registers a single **Grid Meter** accessory using the Eve Energy service UUID.

| Characteristic | Source | Notes |
|---|---|---|
| On | `InstantaneousDemand > 0` | True when consuming grid power |
| OutletInUse | Always `true` | Required by Eve Energy |
| Eve Watts | `InstantaneousDemand × 1000` | Real-time power in Watts |
| Eve kWh | `CurrentSummationDelivered` | Lifetime import energy |

**Note on net export:** `InstantaneousDemand` is always non-negative — it does not go negative during solar export. Net export is visible only through `CurrentSummationReceived` accumulating over time, which is stored internally but not yet exposed as a separate accessory.

---

## Error Handling

The plugin is designed to be resilient to transient EAGLE-200 failures:

- If the EAGLE is unreachable at startup, discovery retries every 30 seconds
- Poll cycles are skipped (not fatal) on timeout, XML parse errors, or HTTP 5xx responses
- HTTP 401 triggers a 60-second backoff and an error log (check your credentials)
- The EAGLE's embedded HTTP server can be overwhelmed by frequent polling; the default 15-second interval is conservative by design
- HomeKit characteristics retain their last known-good values during outages

---

## Building from Source

```bash
git clone https://github.com/dacarson/homebridge-rainforest-eagle3.git
cd homebridge-rainforest-eagle3
npm install
npm run build
```

To develop with live rebuilds:

```bash
npm run watch
```

---

## Related Plugins

- [homebridge-pvs6](https://github.com/dacarson/homebridge-pvs6) — SunPower PVS6 solar production, designed to sit alongside this plugin in Apple Home

---

## License

Apache-2.0
