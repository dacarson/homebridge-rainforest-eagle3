# homebridge-rainforest-eagle3 — Project Specification

A Homebridge plugin that exposes Rainforest Automation EAGLE-200 smart meter data to Apple HomeKit via an Eve Energy accessory with fakegato history support.

> **npm package / platform name:** `homebridge-rainforest-eagle3` (matches the repository). The Homebridge platform identifier remains `EAGLE`.

---

## Overview

`homebridge-eagle` polls the EAGLE-200 **local** HTTP API (same LAN only) and publishes a single **Grid Meter** HomeKit accessory showing real-time electricity demand, cumulative import, and cumulative export. It is designed to complement `homebridge-pvs6` — the two plugins are fully independent but sit alongside each other naturally in Apple Home and the Eve app.

The EAGLE-200 connects to the utility smart meter via ZigBee HAN (Home Area Network). It exposes live demand and summation data locally over plain HTTP — no cloud account or internet access required at runtime.

---

## Supported Hardware

| Device | Notes |
|---|---|
| Rainforest EAGLE-200 (RFA-Z114) | Local API; firmware Sep 2017 (v1.0) or later. **Primary target.** |
| Rainforest EAGLE-3 | Newer hardware that reportedly shares the same `post_manager` local API. **Unverified** against this plugin — expected to work if it uses the EAGLE-200 local API, but not tested. |
| Original EAGLE (Z109) | Uses a different relay-server REST API — **not supported** by this plugin |

This plugin targets the **EAGLE-200 local API only** (the `POST /cgi-bin/post_manager` XML-fragment interface documented in the *EAGLE-200 Local API Manual v1.0*). The EAGLE-3 is expected to be compatible because it exposes the same local API, but is treated as unverified. The cloud/relay-server API is a separate, older spec and is out of scope.

---

## Architecture

```
Homebridge (Node.js)
  └── homebridge-eagle plugin
        ├── EagleClient           — XML POST transport, device discovery, polling
        └── GridMeterAccessory    — Eve Energy + fakegato history
```

---

## API Overview

### Transport

- **Endpoint**: `POST http://<host>/cgi-bin/post_manager`  
  (also reachable via mDNS as `http://eagle-<CloudID>.local/cgi-bin/post_manager`)
- **Protocol**: Plain HTTP (not HTTPS)
- **Auth**: HTTP Basic, per-request. Username = Cloud ID (last 6 digits of Ethernet MAC), password = Install Code. Both printed on the label on the underside of the device.
- **Content-Type**: `text/xml`
- **Body**: XML fragment (not a full XML document — no `<?xml?>` declaration, no root element wrapper)
- **HTTP version**: **HTTP/1.0.** Sending the request as HTTP/1.0 makes the EAGLE respond with a `Content-Length` header and a single, complete body. Under HTTP/1.1 the EAGLE replies with `Transfer-Encoding: chunked`, which is best avoided here. Node's high-level HTTP client (and therefore `axios`) always negotiates HTTP/1.1 and cannot downgrade, so the request must be issued over a raw TCP socket (`net.Socket`) with a hand-built `HTTP/1.0` request line and headers, reading the response until the socket closes. See *Transport implementation* below.

### Authentication credential format

The `Authorization` header uses standard Basic Auth: Base64-encode `"<CloudID>:<InstallCode>"`.

Example: Cloud ID `004792`, Install Code `bfb0fc05f51a3932` →  
Base64(`004792:bfb0fc05f51a3932`) → `MDA0NzkyOmJmYjBmYzA1ZjUxYTM5MzI=`

### Request structure

```
POST /cgi-bin/post_manager HTTP/1.0
Host: <host>
Content-type: text/xml
Content-Length: <n>
Authorization: Basic <base64credential>

<Command>
  <Name>...</Name>
  ...
</Command>
```

Every line (request line, each header, the blank separator line, and lines within the XML body) must terminate with CRLF (`\r\n`), per the manual. `Content-Length` must equal the exact byte length of the body.

### Transport implementation

Because Node/`axios` cannot emit an HTTP/1.0 request, `EagleClient` builds the request manually:

1. Open a `net.Socket` (plain TCP, no TLS) to `<host>:80`.
2. Write the request line `POST /cgi-bin/post_manager HTTP/1.0`, the headers (`Host`, `Content-type`, `Content-Length`, `Authorization: Basic …`), a blank line, then the XML body — all CRLF-terminated.
3. Accumulate all received bytes until the server closes the connection (HTTP/1.0 has no keep-alive by default).
4. Split off the status line + headers at the first blank line (`\r\n\r\n`); verify the status code; parse the remaining body as XML.
5. Enforce the configured timeout on the socket and ensure it is always destroyed (single in-flight request at a time).

### Response structure

The EAGLE responds with HTTP 200 and an XML fragment body. Element names are case-insensitive. Values are always ASCII text strings — numeric values must be parsed from the string.

---

## EagleClient — Commands & Data Flow

### Startup: device discovery

Send `device_list` to find the meter's hardware address:

```xml
<Command>
  <Name>device_list</Name>
</Command>
```

Response contains one `<Device>` per known device (HAN meter + any Control Network subdevices). Filter for `<ModelId>electric_meter</ModelId>` to find the utility meter:

```xml
<DeviceList>
  <Device>
    <HardwareAddress>0x0000000000000000</HardwareAddress>
    <Manufacturer>...</Manufacturer>
    <ModelId>electric_meter</ModelId>
    <Protocol>Zigbee</Protocol>
    <LastContact>0x5ab5bd9b</LastContact>
    <ConnectionStatus>Connected</ConnectionStatus>
    <NetworkAddress>0x0000</NetworkAddress>
  </Device>
</DeviceList>
```

Cache the `HardwareAddress` value **verbatim** in memory for all subsequent `device_query` calls. The value returned by `device_list` already includes the `0x` prefix (e.g. `0x000781000081fd0b`) — use it as-is. Do **not** re-prepend `0x`, or the request will contain a malformed `0x0x…` address.

### Poll command

On each poll cycle, send a targeted `device_query` requesting only the three variables needed:

```xml
<Command>
  <Name>device_query</Name>
  <DeviceDetails>
    <HardwareAddress>{meterAddress}</HardwareAddress>
  </DeviceDetails>
  <Components>
    <Component>
      <Name>Main</Name>
      <Variables>
        <Variable><Name>zigbee:InstantaneousDemand</Name></Variable>
        <Variable><Name>zigbee:CurrentSummationDelivered</Name></Variable>
        <Variable><Name>zigbee:CurrentSummationReceived</Name></Variable>
      </Variables>
    </Component>
  </Components>
</Command>
```

> **Note on `zigbee:CurrentSummationReceived`:** The documented `electric_meter` variable list (manual p.12–13) includes `InstantaneousDemand`, `Multiplier`, `Divisor`, `CurrentSummationDelivered`, `Price`, `RateLabel`, and `Message`, but does **not** list `CurrentSummationReceived`. Many meters/firmwares therefore will not return it. Request it best-effort: store the value if present, and silently ignore its absence (handled by the missing-variable fallback). Do not treat a missing export value as an error.

Response shape:

```xml
<Device>
  <DeviceDetails>
    <HardwareAddress>0x0000000000000000</HardwareAddress>
    <ConnectionStatus>Connected</ConnectionStatus>
    ...
  </DeviceDetails>
  <Components>
    <Component>
      <Name>Main</Name>
      <Variables>
        <Variable>
          <Name>zigbee:InstantaneousDemand</Name>
          <Value>1.234 kW</Value>
        </Variable>
        <Variable>
          <Name>zigbee:CurrentSummationDelivered</Name>
          <Value>12345.678 kWh</Value>
        </Variable>
        <Variable>
          <Name>zigbee:CurrentSummationReceived</Name>
          <Value>678.901 kWh</Value>
        </Variable>
      </Variables>
    </Component>
  </Components>
</Device>
```

### Optional: force a live refresh

The EAGLE buffers the last value received from the meter over ZigBee. To force it to actively request a fresh reading, add `<Refresh>Y</Refresh>` to a variable. Note: the refresh request itself returns no value — a second `device_query` (without refresh) is needed to read the updated value. This adds a round-trip delay and is **not recommended** for routine polling; the meter pushes updates every ~8 seconds automatically.

---

## Data Mapping

All `<Value>` fields are ASCII text strings with embedded units (e.g. `"21.499 kW"`, `"12345.678 kWh"` — confirmed in manual p.12). Parse by stripping the unit suffix and converting to float. The EAGLE has **already applied** the meter's `zigbee:Multiplier` / `zigbee:Divisor` scaling to produce the formatted string, so those variables do not need to be requested or applied by the plugin. Parse the unit token defensively (expect `kW`/`kWh`) so an unexpected unit can be logged rather than silently mis-scaled.

| ZigBee Variable | Meaning | Unit | HomeKit use |
|---|---|---|---|
| `zigbee:InstantaneousDemand` | Real-time grid demand | kW | Eve Watt (×1000 → W) |
| `zigbee:CurrentSummationDelivered` | Lifetime energy imported from grid | kWh | Eve kWh |
| `zigbee:CurrentSummationReceived` | Lifetime energy exported to grid | kWh | Stored; future accessory |

**Sign convention**: `InstantaneousDemand` is always a non-negative value — it represents demand on the grid as seen by the utility meter. It does not go negative during solar export. Net export is visible only through `SummationReceived` accumulating over time. The plugin reports demand as-is; the PVS6 plugin provides complementary solar production data.

**Documented meter variable list** (from `device_details`, manual p.12–13 — exact set varies by meter/firmware):

```
zigbee:InstantaneousDemand
zigbee:Multiplier
zigbee:Divisor
zigbee:CurrentSummationDelivered
zigbee:Price
zigbee:RateLabel
zigbee:Message
```

`zigbee:CurrentSummationReceived` is **not** in the documented list and may be unavailable on a given meter (see the note in the Poll command section). Use the live `device_details` command at runtime for diagnostics rather than assuming a fixed variable set.

---

## HomeKit Accessory

### Grid Meter Accessory

**Accessory type:** Eve Energy  
**Custom HAP service UUID:** `E863F10A-079E-48FF-8F27-9C2605A29F52`  
**Display name (configurable):** `Grid Meter`

| Characteristic | HAP UUID | Source | Notes |
|---|---|---|---|
| `On` (read-only) | `00000025` | `InstantaneousDemand > 0` | Consuming = on. The HAP `On` characteristic is technically writable; the setter is a no-op that immediately reverts to the polled state. |
| `OutletInUse` | `00000026` | always `true` | Required by Eve Energy |
| Eve Watt | `E863F10D` | `InstantaneousDemand × 1000` | Watts |
| Eve kWh | `E863F10C` | `CurrentSummationDelivered` | Lifetime import kWh |
| `Name` | `00000023` | config `meterName` | |

**fakegato history:** Records `{ time, power }` (W) at each successful poll.  
History service UUID: `E863F007-079E-48FF-8F27-9C2605A29F52`.  
Persisted to Homebridge storage directory; survives restarts.

**Apple Home tile:** Renders as a smart plug. `On` = actively consuming grid power. Wattage visible in detail view. Eve app shows up to 7 days of native consumption history.

---

## Configuration

Configured via `config.json` in the Homebridge `platforms` array:

```json
{
  "platform": "EAGLE",
  "name": "EAGLE",
  "host": "192.168.1.x",
  "cloudId": "004792",
  "installCode": "bfb0fc05f51a3932",
  "pollInterval": 15,
  "meterName": "Grid Meter"
}
```

The device is also reachable via mDNS hostname `eagle-<cloudId>.local` if a static IP is not preferred.

### Config schema (`config.schema.json`)

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | string | yes | — | IP address or mDNS hostname of EAGLE-200 |
| `cloudId` | string | yes | — | Cloud ID from device label (upper-left, 6 hex chars) |
| `installCode` | string | yes | — | Install Code from device label (16 hex chars) |
| `pollInterval` | integer | no | `15` | Seconds between polls. Minimum enforced: `5` |
| `meterName` | string | no | `"Grid Meter"` | HomeKit display name |

---

## Session Management

The EAGLE-200 local API is **stateless** — no session cookie, no token exchange. Each POST is independently authenticated with Basic Auth credentials in the header. `EagleClient` includes credentials on every request; there is no login/logout lifecycle.

**Meter address caching:** Performed once at startup via `device_list`. Stored in memory for the process lifetime. A Homebridge restart re-discovers the address, which handles any edge case where it changes.

---

## Error Handling

| Condition | Behaviour |
|---|---|
| EAGLE unreachable at startup | Log error, retry `device_list` every 30s |
| `device_list` returns no `electric_meter` device | Log warning, retry every 60s |
| Meter `ConnectionStatus` is not `Connected` | Log warning, skip poll cycle |
| Poll timeout (>10s) | Skip cycle, log warning, retain last values |
| XML parse failure / truncated body | Log warning with raw response body, treat as skipped cycle, retain last values |
| Missing variable in poll response | Use last known good value, log debug |
| HTTP 401 | Log error (wrong credentials); back off 60s, do not retry immediately |
| HTTP 503 / other 5xx | Device HTTP server overloaded. Skip cycle, log warning, and apply a short backoff (e.g. temporarily widen the poll interval) to avoid hammering the device |
| `pollInterval` < 5 in config | Clamp to 5, log warning |

> **Overload caution:** The EAGLE's embedded HTTP server is easily overwhelmed by frequent polling and will respond with `503` errors or truncated/unparseable XML. Treat these as transient skipped cycles (not fatal), back off rather than retrying immediately, and keep the default `pollInterval` conservative. A single in-flight request at a time should be enforced (no overlapping polls).

Accessories remain visible in HomeKit during outages; characteristic values freeze at last known good until connectivity resumes.

---

## Key Differences from homebridge-pvs6

| Aspect | homebridge-pvs6 | homebridge-eagle |
|---|---|---|
| Protocol | HTTPS (self-signed cert) | HTTP plain |
| Auth | Session cookie; re-auth on 401 | Stateless Basic Auth per request |
| Data format | JSON (varserver key/value) | XML fragments |
| Startup | Build varserver cache IDs | Discover meter `HardwareAddress` |
| Value format | Native float in JSON | ASCII string with unit suffix |
| Accessories | Solar + Grid (each optional) | Grid only |
| Negative power | `net_p` goes negative on export | `InstantaneousDemand` always ≥ 0 |

---

## fakegato Integration

Uses [`fakegato-history`](https://github.com/simont77/fakegato-history) npm package.

- History type: `energy`
- Data logged: `{ time, power }` in Watts at each successful poll
- Persisted to Homebridge storage directory
- Eve app renders up to 7 days of native consumption history natively

---

## File Structure

```
homebridge-eagle/
├── src/
│   ├── index.ts                  — Homebridge platform registration
│   ├── platform.ts               — EAGLEPlatform class, accessory lifecycle
│   ├── eagleClient.ts            — HTTP POST, XML parsing, device discovery, polling
│   ├── gridMeterAccessory.ts     — Grid HomeKit accessory + fakegato
│   └── eveCharacteristics.ts    — Eve custom UUID definitions
├── config.schema.json
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `homebridge` | Peer dependency |
| `fakegato-history` | Eve history storage and HAP service |
| `fast-xml-parser` | XML response parsing. Responses arrive as a single rooted element (`<Device>`, `<DeviceList>`), so they parse directly — no synthetic root wrapper is needed. Request bodies are sent as raw XML fragments. |

The HTTP/1.0 transport is built on Node's core `net` module (raw TCP socket); no third-party HTTP client (`axios`/`node-fetch`) is required. Basic Auth is added by Base64-encoding `"<CloudID>:<InstallCode>"` into the `Authorization` header manually.

Node.js ≥ 18 required.

---

## Shared Code Opportunity

`eveCharacteristics.ts` is identical between `homebridge-pvs6` and `homebridge-eagle`. If both plugins are maintained in the same repository or as a monorepo, this file can be shared. For standalone npm distribution, duplicating the small file keeps each plugin self-contained and dependency-free between them.

---

## Out of Scope (v1)

- `CurrentSummationReceived` as a separate HomeKit accessory (lifetime export kWh)
- Utility price / tariff data (`zigbee:Price`, `zigbee:PriceTier`)
- Utility push messages (`zigbee:Message`, `confirm_message`)
- Fast-poll mode (`set_fast_poll` ZigBee SEP 1.1 command)
- Cloud / relay-server API (rainforestcloud.com)
- Control Network subdevices (smart plugs, thermostats, load switches)
- Original EAGLE Z109

---

## Future Considerations

- `CurrentSummationReceived` as a second read-only Eve Energy accessory for lifetime solar export kWh (net metering tracking)
- A derived `Net Power` value combining EAGLE demand with PVS6 production — could live in a separate aggregator platform plugin
- Prometheus metrics sidecar endpoint (consistent pattern with homebridge-pvs6)
- `device_details` diagnostic command exposed via a Homebridge UI button for troubleshooting
