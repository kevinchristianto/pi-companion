import type { WindowCommand } from './platform';

/** A pointer session owns exactly one native drag. Only one IPC may be in flight;
 * pointer movement is coalesced into at most one update per animation frame. */
export class TaskbarDrag {
  private session: { active: boolean; busy: boolean; dirty: boolean; ending: boolean; frame: number | null } | null = null;
  constructor(private readonly command: (command: WindowCommand) => Promise<unknown>, private readonly receive: (state: unknown) => void, private readonly failed: (error: unknown) => void, private readonly changed: (active: boolean) => void) {}
  get active() { return this.session !== null; }
  start(): boolean {
    if (this.session) return false;
    const session: NonNullable<TaskbarDrag['session']> = this.session = { active: true, busy: true, dirty: false, ending: false, frame: null };
    this.changed(true);
    void this.command({ name: 'begin_taskbar_drag' }).then(value => this.accept(value), error => { this.failed(error); session.active = false; session.dirty = false; }).finally(() => { session.busy = false; this.advance(session); });
    return true;
  }
  move(): void { if (this.session?.active) { this.session.dirty = true; this.advance(this.session); } }
  stop(flushFinal = false): void {
    const session = this.session; if (!session) return;
    session.active = false; session.dirty = flushFinal;
    if (session.frame !== null) cancelAnimationFrame(session.frame);
    session.frame = null; this.advance(session);
  }
  private accept(value: unknown) { if (value !== undefined && value !== null) this.receive(value); }
  private advance(session: NonNullable<TaskbarDrag['session']>): void {
    if (session !== this.session || session.busy || session.ending) return;
    if (!session.active) {
      if (session.dirty) {
        // Pointerup samples the final physical cursor once, even when its move
        // arrived before the next RAF. Cancellation deliberately discards it.
        session.dirty = false; session.busy = true;
        void this.command({ name: 'update_taskbar_drag' }).then(value => this.accept(value), error => this.failed(error)).finally(() => { session.busy = false; this.advance(session); });
        return;
      }
      session.ending = true;
      // Also end a rejected begin: native setup may have completed before a
      // transport error. A release during begin/update must still end afterward.
      void this.command({ name: 'end_taskbar_drag' }).then(value => this.accept(value), error => this.failed(error)).finally(() => { if (this.session === session) { this.session = null; this.changed(false); } });
    } else if (session.dirty && session.frame === null) {
      session.frame = requestAnimationFrame(() => {
        session.frame = null; if (!session.active) { this.advance(session); return; }
        session.dirty = false; session.busy = true;
        void this.command({ name: 'update_taskbar_drag' }).then(value => this.accept(value), error => { this.failed(error); session.active = false; session.dirty = false; }).finally(() => { session.busy = false; this.advance(session); });
      });
    }
  }
}
