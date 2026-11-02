import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { API, Logger } from 'homebridge';
import { MatterEnergyBridge } from './matterEnergy';

const POLL_S = 15;
const INTERVAL_S = MatterEnergyBridge.PERIODIC_INTERVAL_S;

interface EnergyStruct {
  energy: number;
  startTimestamp?: number;
  endTimestamp?: number;
}
type EnergyUpdate = Record<string, EnergyStruct>;

async function setup() {
  let nowMs = 1_700_000_000_000;
  const energyCalls: EnergyUpdate[] = [];
  const powerCalls: unknown[] = [];
  const api = {
    matter: {
      deviceTypes: { ElectricalSensor: {} },
      registerPlatformAccessories: async () => {},
      updateAccessoryState: async (_uuid: string, cluster: string, state: unknown) => {
        if (cluster === 'electricalEnergyMeasurement') {
          energyCalls.push(state as EnergyUpdate);
        } else {
          powerCalls.push(state);
        }
      },
      uuid: { generate: (s: string) => s },
    },
  } as unknown as API;
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop } as unknown as Logger;

  const bridge = new MatterEnergyBridge(api, log, 'bidirectional', () => nowMs);
  // The platform registers with placeholder zero readings.
  await bridge.register('meter', 'Grid', 'SN', { powerW: 0, importedEnergyKWh: 0, exportedEnergyKWh: 0 });

  let imported = 12345.678;
  let exported = 100;
  const poll = async (deltaImportKWh = 0, deltaExportKWh = 0) => {
    nowMs += POLL_S * 1000;
    imported += deltaImportKWh;
    exported += deltaExportKWh;
    await bridge.update({ powerW: 0, importedEnergyKWh: imported, exportedEnergyKWh: exported });
  };
  const startS = () => Math.floor(nowMs / 1000);
  return { energyCalls, powerCalls, poll, startS };
}

const pollsPerPeriod = INTERVAL_S / POLL_S;

test('first update after registration sends both cumulative and periodic, as before', async () => {
  const { energyCalls, poll } = await setup();
  await poll();
  assert.equal(energyCalls.length, 1);
  assert.deepEqual(Object.keys(energyCalls[0]).sort(), [
    'cumulativeEnergyExported',
    'cumulativeEnergyImported',
    'periodicEnergyExported',
    'periodicEnergyImported',
  ]);
  assert.equal(energyCalls[0].cumulativeEnergyImported.energy, 12_345_678_000);
  assert.deepEqual(energyCalls[0].periodicEnergyImported, { energy: 0 });
});

test('idle: no energy events except the 15-minute heartbeat', async () => {
  const { energyCalls, powerCalls, poll } = await setup();
  await poll(); // first report
  energyCalls.length = 0;

  for (let i = 0; i < pollsPerPeriod - 1; i++) {
    await poll();
  }
  assert.equal(energyCalls.length, 0, 'no energy events before the heartbeat');

  await poll(); // 15 minutes since the first report
  assert.equal(energyCalls.length, 1);
  const hb = energyCalls[0];
  assert.equal(hb.cumulativeEnergyImported.energy, 12_345_678_000);
  assert.equal(hb.periodicEnergyImported.energy, 0);
  assert.equal(hb.periodicEnergyExported.energy, 0);
  assert.equal(hb.periodicEnergyImported.endTimestamp! - hb.periodicEnergyImported.startTimestamp!, INTERVAL_S);

  // One hour idle → 4 heartbeats in total; power is still updated every poll.
  for (let i = 0; i < pollsPerPeriod * 3; i++) {
    await poll();
  }
  assert.equal(energyCalls.length, 4);
  assert.equal(powerCalls.length, 1 + pollsPerPeriod * 4);
});

test('cumulative is sent when it changes; periodic sums across polls into one event', async () => {
  const { energyCalls, poll } = await setup();
  await poll(); // first report, baseline
  // An active (non-idle) period first, so the idle→active early emit is out of the way.
  await poll(0.01);
  energyCalls.length = 0;

  // Over the next period, import 0.001 kWh on alternate polls and export once.
  let expectedImportMWh = 0;
  for (let i = 0; i < pollsPerPeriod; i++) {
    const d = i % 2 === 0 ? 0.001 : 0;
    expectedImportMWh += d * 1_000_000;
    await poll(d, i === 5 ? 0.002 : 0);
  }

  const periodic = energyCalls.filter((c) => c.periodicEnergyImported);
  assert.equal(periodic.length, 1, 'exactly one periodic event per period');
  const p = periodic[0];
  assert.equal(p.periodicEnergyImported.energy, Math.round(expectedImportMWh));
  assert.equal(p.periodicEnergyExported.energy, 2000);
  assert.equal(p.periodicEnergyImported.endTimestamp! - p.periodicEnergyImported.startTimestamp!, INTERVAL_S);

  // Cumulative sent only on polls where the total changed.
  const cumulative = energyCalls.filter((c) => c.cumulativeEnergyImported);
  // Import changes on every other poll, plus the one poll (i = 5) where only export changes.
  assert.equal(cumulative.length, pollsPerPeriod / 2 + 1);
});

test('periodic ignores a counter that steps backwards', async () => {
  const { energyCalls, poll } = await setup();
  await poll();
  await poll(0.01); // idle → active emit
  energyCalls.length = 0;
  await poll(0.005);
  await poll(-0.003);
  await poll(0.004);
  for (let i = 0; i < pollsPerPeriod - 3; i++) {
    await poll();
  }
  const periodic = energyCalls.filter((c) => c.periodicEnergyImported);
  assert.equal(periodic.length, 1);
  assert.equal(periodic[0].periodicEnergyImported.energy, 9000);
});

test('idle → active emits the periodic event promptly', async () => {
  const { energyCalls, poll, startS } = await setup();
  await poll();
  const periodStart = startS();
  for (let i = 0; i < 10; i++) {
    await poll();
  }
  energyCalls.length = 0;

  await poll(0.004); // energy starts flowing
  assert.equal(energyCalls.length, 1);
  const e = energyCalls[0];
  assert.equal(e.periodicEnergyImported.energy, 4000);
  assert.equal(e.periodicEnergyImported.startTimestamp, periodStart);
  assert.equal(e.periodicEnergyImported.endTimestamp, startS());
  assert.equal(e.cumulativeEnergyImported.energy, 12_345_682_000);

  // Now active: further energy accumulates until the period ends.
  energyCalls.length = 0;
  for (let i = 0; i < pollsPerPeriod - 1; i++) {
    await poll(0.001);
  }
  assert.equal(energyCalls.filter((c) => c.periodicEnergyImported).length, 0);
  await poll(0.001);
  const periodic = energyCalls.filter((c) => c.periodicEnergyImported);
  assert.equal(periodic.length, 1);
  assert.equal(periodic[0].periodicEnergyImported.energy, pollsPerPeriod * 1000);
});

test('active → idle period re-arms the prompt emit', async () => {
  const { energyCalls, poll } = await setup();
  await poll();
  await poll(0.001); // idle → active
  for (let i = 0; i < pollsPerPeriod; i++) {
    await poll(); // a full period that ends with zero energy → idle
  }
  energyCalls.length = 0;
  await poll(0.002);
  const periodic = energyCalls.filter((c) => c.periodicEnergyImported);
  assert.equal(periodic.length, 1);
  assert.equal(periodic[0].periodicEnergyImported.energy, 2000);
});
