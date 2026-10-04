// Clock seam for time-based rules — tests and the smoke script drive a
// ManualClock; the app uses systemClock.

export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export class ManualClock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now: Clock = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
