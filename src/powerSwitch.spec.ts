import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PowerSwitch, SWITCH_OFF_BELOW_W, SWITCH_ON_ABOVE_W } from './powerSwitch';
import { UpdateStats } from './updatePolicy';

const POLL_S = 15;

function makeSwitch(holdSeconds: number) {
  let clock = 1_000_000;
  const debugMessages: string[] = [];
  const stats = new UpdateStats();
  const sw = new PowerSwitch('grid', holdSeconds, stats, (m) => debugMessages.push(m), () => clock);
  // Each call advances one poll interval, then feeds the reading.
  const poll = (watts: number) => {
    clock += POLL_S * 1000;
    return sw.update(watts);
  };
  return { sw, stats, debugMessages, poll };
}

test('deadband constants are 50 W on / 20 W off', () => {
  assert.equal(SWITCH_ON_ABOVE_W, 50);
  assert.equal(SWITCH_OFF_BELOW_W, 20);
});

// --- startup ---

test('first reading is reported immediately, ignoring the hold', () => {
  const on = makeSwitch(60);
  assert.equal(on.sw.state, false);
  assert.equal(on.poll(800), true);
  assert.equal(on.sw.state, true);

  const off = makeSwitch(60);
  assert.equal(off.poll(0), false);
  assert.equal(off.sw.state, false);
});

// --- deadband (hold disabled) ---

test('deadband: turns on only above +50 W', () => {
  const { sw, poll } = makeSwitch(0);
  poll(0);
  assert.equal(poll(30), null);
  assert.equal(poll(50), null);
  assert.equal(sw.state, false);
  assert.equal(poll(50.1), true);
  assert.equal(sw.state, true);
});

test('deadband: turns off only below +20 W', () => {
  const { sw, poll } = makeSwitch(0);
  poll(500);
  assert.equal(poll(40), null);
  assert.equal(poll(20), null);
  assert.equal(sw.state, true);
  assert.equal(poll(19.9), false);
  assert.equal(sw.state, false);
});

test('deadband: readings between 20 W and 50 W keep the current state', () => {
  const { sw, poll } = makeSwitch(0);
  poll(35); // first reading in the band → off
  assert.equal(sw.state, false);
  for (const w of [21, 49, 35, 20, 50]) {
    assert.equal(poll(w), null);
  }
  assert.equal(sw.state, false);
});

test('hold 0: changes are reported on the first poll', () => {
  const { poll, stats } = makeSwitch(0);
  poll(0);
  assert.equal(poll(100), true);
  assert.equal(poll(0), false);
  assert.deepEqual(stats.take(), { sent: 3, suppressed: 0 });
});

// --- hold ---

test('hold: a new state is reported only after it holds for switchHoldSeconds', () => {
  const { sw, poll, stats, debugMessages } = makeSwitch(60);
  poll(0); // off
  stats.take();

  assert.equal(poll(500), null); // pending since t
  assert.equal(poll(500), null); // 15 s
  assert.equal(poll(500), null); // 30 s
  assert.equal(poll(500), null); // 45 s
  assert.equal(sw.state, false);
  assert.equal(poll(500), true); // 60 s
  assert.equal(sw.state, true);
  assert.deepEqual(stats.take(), { sent: 1, suppressed: 4 });
  assert.equal(debugMessages.length, 4);
});

test('hold: a brief spike is never reported', () => {
  const { sw, poll, debugMessages } = makeSwitch(60);
  poll(0);
  assert.equal(poll(2000), null);
  assert.equal(poll(2000), null);
  assert.equal(poll(5), null); // back below the on threshold → cancelled
  assert.equal(sw.state, false);
  assert.match(debugMessages.at(-1)!, /cancelled/);

  // The hold restarts from scratch on the next rise.
  for (let i = 0; i < 4; i++) {
    assert.equal(poll(2000), null);
  }
  assert.equal(poll(2000), true);
});

test('hold: applies to turning off as well', () => {
  const { sw, poll } = makeSwitch(30);
  poll(500); // on
  assert.equal(poll(0), null);
  assert.equal(poll(0), null); // 15 s
  assert.equal(sw.state, true);
  assert.equal(poll(0), false); // 30 s
  assert.equal(sw.state, false);
});

test('hold: a reading in the deadband cancels a pending change', () => {
  const { sw, poll } = makeSwitch(60);
  poll(500); // on
  assert.equal(poll(0), null); // pending off
  assert.equal(poll(30), null); // in band → stays on, pending cleared
  assert.equal(poll(0), null); // pending restarts
  assert.equal(poll(0), null);
  assert.equal(poll(0), null);
  assert.equal(sw.state, true);
  assert.equal(poll(0), null); // 45 s since restart
  assert.equal(poll(0), false); // 60 s
});
