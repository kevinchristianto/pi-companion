/** One capped animation clock for the whole popup, independent of bridge observation. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const realClock: Clock = { now: () => performance.now(), setTimeout: (fn, delay) => setTimeout(fn, delay), clearTimeout: timer => clearTimeout(timer) };
export class RenderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private started = 0;
  private elapsed = 0;
  constructor(private readonly draw: (elapsed: number) => void, private readonly clock: Clock = realClock) {}
  start(): void {
    if (this.running) return;
    this.running = true;
    this.started = this.clock.now() - this.elapsed;
    this.draw(this.elapsed);
    this.schedule();
  }
  stop(): void {
    if (this.running) this.elapsed = this.clock.now() - this.started;
    this.running = false;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
  paint(): void { this.draw(this.running ? this.clock.now() - this.started : this.elapsed); }
  dispose(): void { this.stop(); }
  private schedule(): void {
    this.timer = this.clock.setTimeout(() => {
      if (!this.running) return;
      this.elapsed = this.clock.now() - this.started;
      this.draw(this.elapsed);
      this.schedule();
    }, 125);
  }
}
