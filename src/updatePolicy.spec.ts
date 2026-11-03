import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UPDATE_POLICY,
  EveUpdateThrottle,
  UpdatePolicyOptions,
  UpdateStats,
  resolveUpdatePolicy,
} from './updatePolicy';

function makeThrottle(overrides: Partial<UpdatePolicyOptions> = {}) {
  let clock = 1_000_000;
  const debugMessages: string[] = [];
  const stats = new UpdateStats();
  const throttle = new EveUpdateThrottle(
    { ...DEFAULT_UPDATE_POLICY, ...overrides },
    stats,
    (m) => debugMessages.push(m),
    () => clock,
  );
  return {
    throttle,
    stats,
    debugMessages,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

// --- throttled (default) ---

test('throttled: first value for each key is sent immediately (startup)', () => {
  const { throttle } = makeThrottle();
  assert.equal(throttle.notify, true);
  assert.equal(throttle.shouldSend('grid:EveWatts', 512.3, 'W'), true);
  assert.equal(throttle.shouldSend('grid:EveKWh', 12345.678, 'kWh'), true);
  assert.equal(throttle.shouldSend('export:EveWatts', 0, 'W'), true);
});

test('throttled: watts below max(minChangeWatts, minChangePercent%) are suppressed', () => {
  const { throttle, debugMessages } = makeThrottle();
  throttle.shouldSend('k', 500, 'W');
  // 2% of 500 = 10, so the 25 W floor applies.
  assert.equal(throttle.shouldSend('k', 524.9, 'W'), false);
  assert.equal(throttle.shouldSend('k', 476, 'W'), false);
  assert.equal(debugMessages.length, 2);
  assert.equal(throttle.shouldSend('k', 525, 'W'), true);
});

test('throttled: percent threshold applies when larger than minChangeWatts', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 5000, 'W');
  assert.equal(throttle.shouldSend('k', 5099, 'W'), false); // threshold 100 W
  assert.equal(throttle.shouldSend('k', 5100, 'W'), true);
  assert.equal(throttle.shouldSend('k', 5000, 'W'), false); // threshold now 102 W
  assert.equal(throttle.shouldSend('k', 4998, 'W'), true);
});

test('throttled: threshold is measured against the last value sent', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 500, 'W');
  assert.equal(throttle.shouldSend('k', 515, 'W'), false);
  assert.equal(throttle.shouldSend('k', 530, 'W'), true);
  assert.equal(throttle.shouldSend('k', 550, 'W'), false);
});

test('throttled: kWh uses minChangeKwh, not the watt thresholds', () => {
  const { throttle } = makeThrottle({ minChangeKwh: 0.1 });
  throttle.shouldSend('k', 1000, 'kWh');
  assert.equal(throttle.shouldSend('k', 1000.05, 'kWh'), false);
  assert.equal(throttle.shouldSend('k', 1000.09, 'kWh'), false);
  assert.equal(throttle.shouldSend('k', 1000.1, 'kWh'), true);
  assert.equal(throttle.shouldSend('k', 1000.15, 'kWh'), false);
});

test('throttled: crossing to or from 0 is always sent', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 10, 'W');
  assert.equal(throttle.shouldSend('k', 0, 'W'), true);
  assert.equal(throttle.shouldSend('k', 0, 'W'), false);
  assert.equal(throttle.shouldSend('k', 3, 'W'), true);
});

test('throttled: sends once maxIntervalSeconds has passed since the last push', () => {
  const { throttle, advance } = makeThrottle({ maxIntervalSeconds: 300 });
  throttle.shouldSend('w', 500, 'W');
  throttle.shouldSend('e', 1000, 'kWh');
  advance(299);
  assert.equal(throttle.shouldSend('w', 501, 'W'), false);
  assert.equal(throttle.shouldSend('e', 1000.01, 'kWh'), false);
  advance(1);
  assert.equal(throttle.shouldSend('w', 502, 'W'), true);
  assert.equal(throttle.shouldSend('e', 1000.02, 'kWh'), true);
  advance(299);
  assert.equal(throttle.shouldSend('w', 503, 'W'), false);
});

test('throttled: keys are tracked independently', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('a', 500, 'W');
  throttle.shouldSend('b', 100, 'W');
  assert.equal(throttle.shouldSend('a', 510, 'W'), false);
  assert.equal(throttle.shouldSend('b', 130, 'W'), true);
});

// --- pollOnly ---

test('pollOnly: never pushes, including the first value, and disables NOTIFY', () => {
  const { throttle, stats, debugMessages } = makeThrottle({ evePowerUpdates: 'pollOnly' });
  assert.equal(throttle.notify, false);
  for (const [v, unit] of [[500, 'W'], [10_000, 'W'], [0, 'W'], [1000, 'kWh'], [2000, 'kWh']] as const) {
    assert.equal(throttle.shouldSend('k', v, unit), false);
  }
  assert.deepEqual(stats.take(), { sent: 0, suppressed: 5 });
  assert.equal(debugMessages.length, 0);
});

// --- live ---

test('live: every value is pushed, as before 1.2.0', () => {
  const { throttle, stats, debugMessages } = makeThrottle({ evePowerUpdates: 'live' });
  assert.equal(throttle.notify, true);
  for (const v of [500, 500, 501, 500.1, 0, 0]) {
    assert.equal(throttle.shouldSend('w', v, 'W'), true);
  }
  assert.equal(throttle.shouldSend('e', 1000.001, 'kWh'), true);
  assert.equal(throttle.shouldSend('e', 1000.002, 'kWh'), true);
  assert.deepEqual(stats.take(), { sent: 8, suppressed: 0 });
  assert.equal(debugMessages.length, 0);
});

// --- stats & config ---

test('stats count sent vs suppressed and reset on take()', () => {
  const { throttle, stats } = makeThrottle();
  throttle.shouldSend('k', 500, 'W');
  throttle.shouldSend('k', 501, 'W');
  throttle.shouldSend('k', 502, 'W');
  throttle.shouldSend('k', 600, 'W');
  assert.deepEqual(stats.take(), { sent: 2, suppressed: 2 });
  assert.deepEqual(stats.take(), { sent: 0, suppressed: 0 });
});

test('resolveUpdatePolicy applies defaults and ignores invalid values', () => {
  assert.deepEqual(resolveUpdatePolicy({}), DEFAULT_UPDATE_POLICY);
  assert.deepEqual(DEFAULT_UPDATE_POLICY, {
    evePowerUpdates: 'throttled',
    minChangeWatts: 25,
    minChangePercent: 2,
    minChangeKwh: 0.1,
    maxIntervalSeconds: 300,
    switchHoldSeconds: 60,
  });
  assert.deepEqual(
    resolveUpdatePolicy({
      evePowerUpdates: 'pollOnly',
      minChangeWatts: 10,
      minChangePercent: 0,
      minChangeKwh: 0.5,
      maxIntervalSeconds: 60,
      switchHoldSeconds: 0,
    }),
    {
      evePowerUpdates: 'pollOnly',
      minChangeWatts: 10,
      minChangePercent: 0,
      minChangeKwh: 0.5,
      maxIntervalSeconds: 60,
      switchHoldSeconds: 0,
    },
  );
  assert.deepEqual(
    resolveUpdatePolicy({
      evePowerUpdates: 'sometimes',
      minChangeWatts: -1,
      minChangePercent: 'x',
      minChangeKwh: null,
      maxIntervalSeconds: NaN,
      switchHoldSeconds: -5,
    }),
    DEFAULT_UPDATE_POLICY,
  );
});
