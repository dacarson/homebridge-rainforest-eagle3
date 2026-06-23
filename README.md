# homebridge-rainforest-eagle3
[![License: MIT](https://img.shields.io/github/license/dacarson/homebridge-rainforest-eagle3)](LICENSE)
[![Version](https://img.shields.io/github/v/release/dacarson/homebridge-rainforest-eagle3)](https://github.com/dacarson/homebridge-rainforest-eagle3/releases)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-rainforest-eagle3)](https://www.npmjs.com/package/homebridge-rainforest-eagle3)

A [Homebridge](https://homebridge.io) plugin for the [Rainforest Automation EAGLE-3](https://www.rainforestautomation.com) smart meter gateway. Exposes your utility grid meter as an **Eve Energy** accessory in Apple HomeKit, with real-time power demand, cumulative import energy, and native Eve app consumption history.

<img width="300" alt="Grid Meter - Export" src="https://github.com/user-attachments/assets/9f2bfed2-6ab8-45e0-ab5b-d5ac91f5a38a" />
<img width="300" alt="Grid Meter - Import" src="https://github.com/user-attachments/assets/3c0cba11-386a-4185-bd54-f1c0861454dc" />

---

## Features

- Real-time grid demand in Watts (visible in the Eve app and HomeKit detail view)
- Cumulative energy imported (kWh) as a lifetime total
- Optional **export meter** accessory for homes with solar net metering — shows real-time export watts and lifetime energy exported to the grid
- Up to 7 days of native consumption/export history in the Eve app via [fakegato-history](https://github.com/simont77/fakegato-history)
- Polls the EAGLE-3 **local** HTTP API — no cloud account or internet required at runtime
- Stateless Basic Auth — no session management, no re-login lifecycle

---

## Supported Hardware

| Device | Status |
|---|---|
| Rainforest EAGLE-3 | Tested |
| Rainforest EAGLE-200 (RFA-Z114) | Expected compatible — uses the same local API; unverified |
| Original EAGLE (Z109) | Not supported — uses a different relay-server API |

---

## How It Works

The EAGLE-3 connects to your utility smart meter over ZigBee (HAN) and exposes live meter data over a local HTTP API. This plugin polls that API every `pollInterval` seconds and publishes the data as a HomeKit accessory. All communication is on your local network — no external services involved.

The EAGLE-3's embedded HTTP server requires HTTP/1.0. Standard HTTP libraries (axios, fetch) negotiate HTTP/1.1 and are incompatible, so the plugin uses raw TCP sockets to communicate with the device.

The accessory renders as a **smart plug** in Apple Home:

- **On** — the outlet is "in use" when the grid is actively delivering power (demand > 0 W)
- **Wattage** — visible in the detail view and in the Eve app
- **Energy history** — the Eve app shows up to 7 days of consumption history

---

## Requirements

- [Homebridge](https://homebridge.io) v2.0 or later
- Node.js 18 or later
- Rainforest EAGLE-3 on the same local network as your Homebridge host
- The EAGLE-3's **Cloud ID** and **Install Code** (printed on the label on the underside of the device)

---

## Installation

Install via the Homebridge UI plugin search, or from the command line:

```bash
npm install -g homebridge-rainforest-eagle3
```

---

## Configuration

Add a platform entry to your Homebridge `config.json`.

Minimal setup (import meter only):

```json
{
  "platforms": [
    {
      "platform": "EAGLE",
      "name": "EAGLE",
      "cloudId": "004792",
      "installCode": "bfb0fc05f51a3932"
    }
  ]
}
```

With export meter enabled (for solar / net metering):

```json
{
  "platforms": [
    {
      "platform": "EAGLE",
      "name": "EAGLE",
      "cloudId": "004792",
      "installCode": "bfb0fc05f51a3932",
      "pollInterval": 15,
      "meterName": "Grid Meter - Import",
      "showExportMeter": true,
      "exportMeterName": "Grid Meter - Export"
    }
  ]
}
```

### Configuration Options

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `platform` | string | yes | — | Must be `EAGLE` |
| `host` | string | no | `eagle-<cloudId>.local` | IP address or mDNS hostname of the EAGLE-3. Omit to use mDNS auto-discovery. |
| `cloudId` | string | yes | — | Cloud ID from the device label (6 hex characters, upper-left of label) |
| `installCode` | string | yes | — | Install Code from the device label (16 hex characters) |
| `pollInterval` | integer | no | `15` | Seconds between polls. Minimum enforced: `5` |
| `meterName` | string | no | `"Grid Meter"` | Display name for the import meter accessory. Defaults to `"Grid Meter - Import"` when `showExportMeter` is `true`. |
| `showExportMeter` | boolean | no | `false` | Register a second accessory showing power exported to the grid. |
| `exportMeterName` | string | no | `"Grid Meter - Export"` | Display name for the export meter accessory. |

### Finding Your Credentials

Flip the EAGLE-3 over and look at the label. You need:

- **Cloud ID** — 6-character hex string in the upper-left (e.g. `004792`)
- **Install Code** — 16-character hex string below the Cloud ID (e.g. `bfb0fc05f51a3932`)

The device is also reachable at `eagle-<cloudId>.local` via mDNS if you prefer not to use a static IP.

---

## HomeKit Accessories

### Import Meter (always registered)

| Characteristic | Source | Notes |
|---|---|---|
| On | `demand > 0` | True when consuming grid power |
| OutletInUse | Always `true` | Required by Eve Energy |
| Eve Watts | `max(0, demand) × 1000` | Import watts. Zero when net-exporting. |
| Eve kWh | `CurrentSummationDelivered` | Lifetime energy imported from grid |

### Export Meter (optional — `showExportMeter: true`)

| Characteristic | Source | Notes |
|---|---|---|
| On | `demand < 0` | True when exporting to the grid |
| OutletInUse | Always `true` | Required by Eve Energy |
| Eve Watts | `max(0, −demand) × 1000` | Export watts. Zero when not exporting. |
| Eve kWh | `CurrentSummationReceived` | Lifetime energy exported to grid. Shows `0` if the meter does not report this variable. |

The two accessories are mutually exclusive — at any given moment only one shows a non-zero wattage. Both render as smart plugs in Apple Home; the Eve app shows up to 7 days of history for each.

**Note on `CurrentSummationReceived`:** Many meters and firmware versions do not report this variable. When it is absent, the export kWh characteristic stays at `0`, but the real-time export watts (derived from a negative `InstantaneousDemand`) still work correctly.

---

## Error Handling

The plugin is designed to be resilient to transient EAGLE-3 failures:

- If the EAGLE is unreachable at startup, discovery retries every 30 seconds
- If the EAGLE responds but reports no electric meter device, discovery retries every 60 seconds
- Poll cycles are skipped (not fatal) on timeout, XML parse errors, HTTP 5xx responses, or when the meter's ZigBee connection status is not "connected"
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
