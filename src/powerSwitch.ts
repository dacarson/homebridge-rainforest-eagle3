// On/off state derived from a power reading, for the standard HomeKit On
// characteristic. Stays evented so Home automations keep working, but with
// two safeguards against flapping:
//
//  - Deadband: turns on above SWITCH_ON_ABOVE_W and off below SWITCH_OFF_BELOW_W.
//  - Hold: a new state must persist for holdSeconds before it is reported
//    (0 disables the hold). Automations triggered by the switch can therefore
//    fire up to holdSeconds (plus one poll) after the underlying change.

import { UpdateStats } from './updatePolicy';

/** Switch turns on when power rises above this many watts. */
export const SWITCH_ON_ABOVE_W = 50;
/** Switch turns off when power falls below this many watts. */
export const SWITCH_OFF_BELOW_W = 20;

export class PowerSwitch {
  private reported: boolean | null = null;
  private pendingSince: number | null = null;

  constructor(
    private readonly key: string,
    private readonly holdSeconds: number,
    private readonly stats: UpdateStats = new UpdateStats(),
    private readonly debug: (message: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** The state last reported to HomeKit (false before the first reading). */
  get state(): boolean {
    return this.reported ?? false;
  }

  /**
   * Feed a new power reading. Returns the state to push to HomeKit, or null
   * when the reported state should not change. The first reading is always
   * reported immediately.
   */
  update(watts: number): boolean | null {
    if (this.reported === null) {
      this.reported = watts > SWITCH_ON_ABOVE_W;
      this.stats.sent++;
      return this.reported;
    }

    const target = this.reported ? watts >= SWITCH_OFF_BELOW_W : watts > SWITCH_ON_ABOVE_W;
    if (target === this.reported) {
      if (this.pendingSince !== null) {
        this.debug(`${this.key}: pending change cancelled at ${watts} W, staying ${onOff(target)}`);
        this.pendingSince = null;
      }
      return null;
    }

    const now = this.now();
    if (this.pendingSince === null) {
      this.pendingSince = now;
    }
    const heldS = (now - this.pendingSince) / 1000;
    if (heldS >= this.holdSeconds) {
      this.reported = target;
      this.pendingSince = null;
      this.stats.sent++;
      return target;
    }

    this.stats.suppressed++;
    this.debug(`${this.key}: holding change to ${onOff(target)} at ${watts} W (${heldS}s of ${this.holdSeconds}s)`);
    return null;
  }
}

function onOff(state: boolean): string {
  return state ? 'on' : 'off';
}
