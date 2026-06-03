import * as net from 'net';
import { Logger } from 'homebridge';
import { XMLParser } from 'fast-xml-parser';

export interface MeterReading {
  demand_kw: number;
  summation_delivered_kwh: number;
  summation_received_kwh?: number;
}

// Thrown for HTTP-level errors so the caller can distinguish 401 vs 503 vs other.
export class HttpError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export class EagleClient {
  private readonly auth: string;
  private readonly parser: XMLParser;

  constructor(
    private readonly host: string,
    cloudId: string,
    installCode: string,
    private readonly log: Logger,
  ) {
    this.auth = Buffer.from(`${cloudId}:${installCode}`).toString('base64');
    this.parser = new XMLParser({
      ignoreAttributes: false,
      parseTagValue: false,
      isArray: (name) => name === 'Device' || name === 'Variable',
    });
  }

  // Returns the HardwareAddress of the electric_meter device.
  async discoverMeter(): Promise<string> {
    const body = '<Command>\r\n  <Name>device_list</Name>\r\n</Command>';
    const responseXml = await this.sendCommand(body);
    const parsed = this.parser.parse(responseXml) as Record<string, unknown>;

    const deviceList = parsed['DeviceList'] as Record<string, unknown> | undefined;
    if (!deviceList) {
      throw new Error('device_list response missing <DeviceList> element');
    }

    const devices = deviceList['Device'] as Array<Record<string, string>> | undefined;
    if (!Array.isArray(devices) || devices.length === 0) {
      throw new Error('No devices in device_list response');
    }

    const meter = devices.find(
      (d) => String(d['ModelId'] ?? '').toLowerCase() === 'electric_meter',
    );
    if (!meter) {
      throw new Error('No electric_meter device found in device_list response');
    }

    const address = meter['HardwareAddress'];
    if (!address) {
      throw new Error('electric_meter device has no HardwareAddress');
    }

    // The EAGLE returns the address with the 0x prefix already — use verbatim.
    return String(address);
  }

  // Returns current meter readings. summation_received_kwh is optional — not all
  // meters/firmwares return CurrentSummationReceived.
  async queryMeter(meterAddress: string): Promise<MeterReading> {
    const body = [
      '<Command>',
      '  <Name>device_query</Name>',
      '  <DeviceDetails>',
      `    <HardwareAddress>${meterAddress}</HardwareAddress>`,
      '  </DeviceDetails>',
      '  <Components>',
      '    <Component>',
      '      <Name>Main</Name>',
      '      <Variables>',
      '        <Variable><Name>zigbee:InstantaneousDemand</Name></Variable>',
      '        <Variable><Name>zigbee:CurrentSummationDelivered</Name></Variable>',
      '        <Variable><Name>zigbee:CurrentSummationReceived</Name></Variable>',
      '      </Variables>',
      '    </Component>',
      '  </Components>',
      '</Command>',
    ].join('\r\n');

    const responseXml = await this.sendCommand(body);
    const parsed = this.parser.parse(responseXml) as Record<string, unknown>;

    const device = parsed['Device'] as Record<string, unknown> | undefined;
    if (!device) {
      throw new Error('device_query response missing <Device> element');
    }

    const deviceDetails = device['DeviceDetails'] as Record<string, string> | undefined;
    const connectionStatus = deviceDetails?.['ConnectionStatus'] ?? '';
    if (connectionStatus.toLowerCase() !== 'connected') {
      throw new Error(`Meter ConnectionStatus is '${connectionStatus}', not Connected`);
    }

    // Navigate Device > Components > Component > Variables > Variable[]
    const components = device['Components'] as Record<string, unknown> | undefined;
    const component = components?.['Component'] as Record<string, unknown> | undefined;
    const variables = component?.['Variables'] as Record<string, unknown> | undefined;
    const varList = variables?.['Variable'] as Array<Record<string, string>> | undefined;

    if (!Array.isArray(varList)) {
      throw new Error('device_query response has no <Variable> elements');
    }

    const varMap = new Map<string, string>();
    for (const v of varList) {
      const name = v['Name'];
      const value = v['Value'];
      if (name && value) {
        varMap.set(String(name), String(value));
      }
    }

    const demand_kw = this.parseValue(
      varMap.get('zigbee:InstantaneousDemand'),
      'zigbee:InstantaneousDemand',
    );
    const summation_delivered_kwh = this.parseValue(
      varMap.get('zigbee:CurrentSummationDelivered'),
      'zigbee:CurrentSummationDelivered',
    );

    const receivedRaw = varMap.get('zigbee:CurrentSummationReceived');
    const summation_received_kwh =
      receivedRaw !== undefined
        ? this.parseValue(receivedRaw, 'zigbee:CurrentSummationReceived')
        : undefined;

    return { demand_kw, summation_delivered_kwh, summation_received_kwh };
  }

  // Raw HTTP/1.0 over net.Socket — axios/fetch cannot downgrade from HTTP/1.1.
  private sendCommand(xmlBody: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const bodyBytes = Buffer.from(xmlBody, 'utf8');
      const request =
        `POST /cgi-bin/post_manager HTTP/1.0\r\n` +
        `Host: ${this.host}\r\n` +
        `Content-type: text/xml\r\n` +
        `Content-Length: ${bodyBytes.length}\r\n` +
        `Authorization: Basic ${this.auth}\r\n` +
        `\r\n`;

      const socket = new net.Socket();
      const chunks: Buffer[] = [];
      let settled = false;

      const done = (err?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (err) {
          reject(err);
        }
      };

      socket.setTimeout(10000);

      socket.on('timeout', () => done(new Error('Socket timeout after 10s')));
      socket.on('error', (err) => done(err));

      socket.on('data', (chunk: Buffer) => chunks.push(chunk));

      socket.on('close', () => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();

        const raw = Buffer.concat(chunks).toString('utf8');
        const headerBodySplit = raw.indexOf('\r\n\r\n');
        if (headerBodySplit === -1) {
          reject(new Error('Malformed HTTP response: no header/body separator'));
          return;
        }

        const headerSection = raw.slice(0, headerBodySplit);
        const body = raw.slice(headerBodySplit + 4);

        const statusLine = headerSection.split('\r\n')[0] ?? '';
        const statusMatch = statusLine.match(/^HTTP\/\S+\s+(\d{3})/);
        if (!statusMatch) {
          reject(new Error(`Could not parse HTTP status line: ${statusLine}`));
          return;
        }

        const statusCode = parseInt(statusMatch[1], 10);
        if (statusCode !== 200) {
          reject(new HttpError(statusCode, `HTTP ${statusCode}: ${statusLine}`));
          return;
        }

        if (!body.trim()) {
          reject(new Error('Empty response body'));
          return;
        }

        resolve(body);
      });

      socket.connect(80, this.host, () => {
        socket.write(request);
        socket.write(bodyBytes);
      });
    });
  }

  private parseValue(raw: string | undefined, varName: string): number {
    if (raw === undefined) {
      throw new Error(`Required variable ${varName} missing from response`);
    }

    const trimmed = raw.trim();
    // Expected format: "1.234 kW" or "12345.678 kWh"
    const match = trimmed.match(/^([\d.]+)\s*(\S+)?$/);
    if (!match) {
      throw new Error(`Cannot parse value '${trimmed}' for ${varName}`);
    }

    const unit = match[2] ?? '';
    if (unit && unit !== 'kW' && unit !== 'kWh') {
      this.log.warn(`Unexpected unit '${unit}' for ${varName} — value: ${trimmed}`);
    }

    const parsed = parseFloat(match[1]);
    if (isNaN(parsed)) {
      throw new Error(`NaN after parsing '${trimmed}' for ${varName}`);
    }

    return parsed;
  }
}
