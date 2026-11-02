import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THROTTLE_OPTIONS,
  ThrottleOptions,
  UpdateThrottle,
  resolveThrottleOptions,
} from './updateThrottle';

function makeThrottle(overrides: Partial<ThrottleOptions> = {}) {
  let clock = 1_000_000;
  const debugMessages: string[] = [];
  const throttle = new UpdateThrottle(
    { ...DEFAULT_THROTTLE_OPTIONS, ...overrides },
    (m) => debugMessages.push(m),
    () => clock,
  );
  return {
    throttle,
    debugMessages,
    advance: (seconds: number) => {
      clock += seconds * 1000;
    },
  };
}

test('first value for a key is always sent', () => {
  const { throttle } = makeThrottle();
  assert.equal(throttle.shouldSend('grid:EveWatts', 512.3), true);
  assert.equal(throttle.shouldSend('export:EveWatts', 0), true);
});

test('absolute threshold: changes below minChangeWatts are suppressed', () => {
  const { throttle, debugMessages } = makeThrottle();
  throttle.shouldSend('k', 500);
  // 2% of 500 = 10, so the 25 W floor applies.
  assert.equal(throttle.shouldSend('k', 524.9), false);
  assert.equal(throttle.shouldSend('k', 476), false);
  assert.equal(debugMessages.length, 2);
  assert.equal(throttle.shouldSend('k', 525), true);
});

test('threshold is measured against last sent value, not last reading', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 500);
  assert.equal(throttle.shouldSend('k', 515), false);
  assert.equal(throttle.shouldSend('k', 530), true); // 30 W from 500
  assert.equal(throttle.shouldSend('k', 550), false); // 20 W from 530
});

test('percent threshold applies when larger than minChangeWatts', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 5000);
  // 2% of 5000 = 100 W
  assert.equal(throttle.shouldSend('k', 5099), false);
  assert.equal(throttle.shouldSend('k', 5100), true);
  // Threshold is now 2% of 5100 = 102 W, so a 100 W drop is suppressed.
  assert.equal(throttle.shouldSend('k', 5000), false);
  assert.equal(throttle.shouldSend('k', 4998), true);
});

test('crossing to or from 0 is always sent', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 10);
  assert.equal(throttle.shouldSend('k', 0), true);
  assert.equal(throttle.shouldSend('k', 0), false);
  assert.equal(throttle.shouldSend('k', 3), true);
});

test('sign change is always sent', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 5);
  assert.equal(throttle.shouldSend('k', -5), true);
  assert.equal(throttle.shouldSend('k', -6), false);
  assert.equal(throttle.shouldSend('k', 1), true);
});

test('heartbeat: sends once maxIntervalSeconds has passed since last send', () => {
  const { throttle, advance } = makeThrottle({ maxIntervalSeconds: 300 });
  throttle.shouldSend('k', 500);
  advance(150);
  assert.equal(throttle.shouldSend('k', 501), false);
  advance(149);
  assert.equal(throttle.shouldSend('k', 502), false);
  advance(1);
  assert.equal(throttle.shouldSend('k', 503), true);
  // Heartbeat timer restarts from the new send.
  advance(299);
  assert.equal(throttle.shouldSend('k', 504), false);
  advance(1);
  assert.equal(throttle.shouldSend('k', 504), true);
});

test('keys are tracked independently', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('a', 500);
  throttle.shouldSend('b', 100);
  assert.equal(throttle.shouldSend('a', 510), false);
  assert.equal(throttle.shouldSend('b', 130), true);
});

test('disabled: every value is sent and nothing is counted or logged', () => {
  const { throttle, debugMessages } = makeThrottle({ enabled: false });
  for (const v of [500, 500, 501, 500.1, 0, 0]) {
    assert.equal(throttle.shouldSend('k', v), true);
  }
  assert.deepEqual(throttle.takeStats(), { sent: 0, suppressed: 0 });
  assert.equal(debugMessages.length, 0);
});

test('takeStats returns counts and resets them', () => {
  const { throttle } = makeThrottle();
  throttle.shouldSend('k', 500);
  throttle.shouldSend('k', 501);
  throttle.shouldSend('k', 502);
  throttle.shouldSend('k', 600);
  assert.deepEqual(throttle.takeStats(), { sent: 2, suppressed: 2 });
  assert.deepEqual(throttle.takeStats(), { sent: 0, suppressed: 0 });
});

test('resolveThrottleOptions applies defaults and ignores invalid values', () => {
  assert.deepEqual(resolveThrottleOptions({}), DEFAULT_THROTTLE_OPTIONS);
  assert.deepEqual(
    resolveThrottleOptions({
      throttleUpdates: false,
      minChangeWatts: 10,
      minChangePercent: 0,
      maxIntervalSeconds: 60,
    }),
    { enabled: false, minChangeWatts: 10, minChangePercent: 0, maxIntervalSeconds: 60 },
  );
  assert.deepEqual(
    resolveThrottleOptions({
      throttleUpdates: 'yes',
      minChangeWatts: -1,
      minChangePercent: 'x',
      maxIntervalSeconds: NaN,
    }),
    DEFAULT_THROTTLE_OPTIONS,
  );
});
