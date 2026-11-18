import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVE_HISTORY_INTERVAL_MS,
  EVE_HISTORY_MAX_POWER_W,
  EveEnergyHistory,
  EveHistoryRecorder,
  eveHistoryMaxGapMs,
} from './eveHistory';

const T0 = 1_700_000_000_000;
const S = 1000;

test('constant power averages to that power', () => {
  const h = new EveEnergyHistory();
  for (let t = 0; t <= 600; t += 15) {
    h.sample(1200, T0 + t * S);
  }
  assert.deepEqual(h.flush(T0 + 600 * S), { powerW: 1200, averageW: 1200 });
});

test('average is weighted by time, not by sample count', () => {
  const h = new EveEnergyHistory();
  // 1000 W for 60 s, then 0 W for 540 s, with many samples during the 0 W part.
  h.sample(1000, T0);
  for (let t = 60; t <= 600; t += 5) {
    h.sample(0, T0 + t * S);
  }
  assert.equal(h.flush(T0 + 600 * S)?.averageW, 100);
});

/** Sample `powerW` every 15 s from fromS (inclusive) to toS (exclusive). */
function feed(h: EveEnergyHistory, powerW: number, fromS: number, toS: number): void {
  for (let t = fromS; t < toS; t += 15) {
    h.sample(powerW, T0 + t * S);
  }
}

test('power above the uint16 limit is capped, not wrapped', () => {
  const h = new EveEnergyHistory();
  feed(h, 9183, 0, 600);
  const r = h.flush(T0 + 600 * S);
  assert.equal(r?.averageW, 9183);
  assert.equal(r?.powerW, EVE_HISTORY_MAX_POWER_W);
  assert.ok((r?.powerW ?? 0) * 10 <= 0xffff);
});

test('negative and non-finite power is treated as 0', () => {
  const h = new EveEnergyHistory();
  feed(h, -500, 0, 300);
  feed(h, NaN, 300, 600);
  assert.equal(h.flush(T0 + 600 * S)?.averageW, 0);
});

test('windows are independent and power carries across the edge', () => {
  const h = new EveEnergyHistory();
  feed(h, 600, 0, 600); // last sample at 585 s
  assert.equal(h.flush(T0 + 600 * S)?.averageW, 600);
  // 600 W from the 585 s sample carries into the next window until the next sample.
  h.sample(0, T0 + 610 * S);
  assert.equal(h.flush(T0 + 620 * S)?.averageW, 300);
});

test('gaps longer than the limit are not counted', () => {
  const h = new EveEnergyHistory(120 * S);
  h.sample(2000, T0);
  h.sample(1000, T0 + 60 * S); // 60 s of 2000 W
  h.sample(1000, T0 + 500 * S); // 440 s gap: dropped
  const r = h.flush(T0 + 600 * S); // 100 s of 1000 W
  assert.equal(r?.averageW, Math.round(((2000 * 60 + 1000 * 100) / 160) * 10) / 10);
});

test('a window with no covered time yields no entry', () => {
  const h = new EveEnergyHistory();
  assert.equal(h.flush(T0), null);
  h.sample(500, T0);
  assert.equal(h.flush(T0), null);
  h.sample(500, T0 + 60 * S);
  assert.equal(h.flush(T0 + 120 * S)?.averageW, 500);
});

test('max gap scales with long poll intervals', () => {
  assert.equal(eveHistoryMaxGapMs(15 * S), 120 * S);
  assert.equal(eveHistoryMaxGapMs(300 * S), 750 * S);
});

test('recorder writes one capped entry per window and logs the cap once', () => {
  let clock = T0;
  const entries: Array<{ time: number; power: number }> = [];
  const info: string[] = [];
  let shutdown: (() => void) | undefined;
  const rec = new EveHistoryRecorder({
    historyService: { addEntry: (e: { time: number; power: number }) => entries.push(e) },
    pollIntervalMs: 15 * S,
    name: 'Test',
    log: { info: (m) => info.push(m), debug: () => {} },
    onShutdown: (l) => {
      shutdown = l;
    },
    now: () => clock,
  });
  try {
    for (let w = 0; w < 2; w++) {
      for (let t = 0; t < EVE_HISTORY_INTERVAL_MS; t += 15 * S) {
        rec.sample(8000);
        clock += 15 * S;
      }
      rec.record();
    }
    assert.deepEqual(entries, [
      { time: Math.round((T0 + EVE_HISTORY_INTERVAL_MS) / 1000), power: EVE_HISTORY_MAX_POWER_W },
      { time: Math.round((T0 + 2 * EVE_HISTORY_INTERVAL_MS) / 1000), power: EVE_HISTORY_MAX_POWER_W },
    ]);
    assert.equal(info.length, 1);
  } finally {
    shutdown?.();
  }
});
