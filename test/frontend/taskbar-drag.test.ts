import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskbarDrag } from '../../src/taskbar-drag';
import type { WindowCommand } from '../../src/platform';
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let calls: WindowCommand[];
let pending: { resolve(value?: unknown): void; reject(error: Error): void }[];
let changed: ReturnType<typeof vi.fn>, received: ReturnType<typeof vi.fn>, failed: ReturnType<typeof vi.fn>;
let drag: TaskbarDrag;
beforeEach(() => {
  vi.useFakeTimers(); calls = []; pending = []; changed = vi.fn(); received = vi.fn(); failed = vi.fn();
  drag = new TaskbarDrag(command => { calls.push(command); return new Promise((resolve, reject) => pending.push({ resolve, reject })); }, received, failed, changed);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('bounded native taskbar pointer session', () => {
  it('coalesces pointer floods to a single RAF update, never overlapping IPC', async () => {
    expect(drag.start()).toBe(true); expect(drag.start()).toBe(false);
    for (let i = 0; i < 100; i++) drag.move();
    vi.advanceTimersByTime(100); expect(calls).toEqual([{ name: 'begin_taskbar_drag' }]);
    pending.shift()!.resolve({ sequence: 1 }); await settle();
    vi.advanceTimersByTime(17); expect(calls.at(-1)).toEqual({ name: 'update_taskbar_drag' });
    for (let i = 0; i < 100; i++) drag.move();
    vi.advanceTimersByTime(100); expect(calls).toHaveLength(2);
    pending.shift()!.resolve(); await settle(); vi.advanceTimersByTime(17); expect(calls).toHaveLength(3);
    drag.stop(); pending.shift()!.resolve(); await settle(); expect(calls.at(-1)).toEqual({ name: 'end_taskbar_drag' });
    pending.shift()!.resolve(); await settle(); expect(drag.active).toBe(false); expect(changed.mock.calls).toEqual([[true], [false]]);
    expect(received).toHaveBeenCalledWith({ sequence: 1 });
  });
  it('ends after a delayed begin even when pointer release arrives first', async () => {
    drag.start(); drag.move(); drag.stop(); drag.stop();
    expect(calls).toHaveLength(1); pending.shift()!.resolve(); await settle();
    expect(calls).toEqual([{ name: 'begin_taskbar_drag' }, { name: 'end_taskbar_drag' }]);
    pending.shift()!.resolve(); await settle(); vi.advanceTimersByTime(1000);
    expect(calls).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a scheduled frame and only starts another session after cleanup', async () => {
    drag.start(); pending.shift()!.resolve(); await settle(); drag.move(); drag.stop();
    expect(drag.start()).toBe(false); vi.advanceTimersByTime(100);
    expect(calls.at(-1)).toEqual({ name: 'end_taskbar_drag' }); expect(calls).toHaveLength(2);
    pending.shift()!.resolve(); await settle(); expect(drag.start()).toBe(true);
  });
  it.each(['begin', 'update'])('cleans native state after a %s failure and reports it once', async stage => {
    drag.start();
    if (stage === 'update') { pending.shift()!.resolve(); await settle(); drag.move(); vi.advanceTimersByTime(17); }
    const error = new Error('Native window changed'); pending.shift()!.reject(error); await settle();
    expect(failed).toHaveBeenCalledExactlyOnceWith(error); expect(calls.at(-1)).toEqual({ name: 'end_taskbar_drag' });
    pending.shift()!.resolve(); await settle(); expect(drag.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('flushes the final physical cursor sample on release, including a move before begin settles', async () => {
    drag.start(); drag.move(); drag.stop(true); pending.shift()!.resolve(); await settle();
    expect(calls.map(command => command.name)).toEqual(['begin_taskbar_drag', 'update_taskbar_drag']);
    pending.shift()!.resolve(); await settle(); expect(calls.at(-1)).toEqual({ name: 'end_taskbar_drag' });
    pending.shift()!.resolve(); await settle(); expect(vi.getTimerCount()).toBe(0);
  });
  it('lets blur or native recovery cancel a release sample queued behind begin', async () => {
    drag.start(); drag.move(); drag.stop(true); drag.stop(); pending.shift()!.resolve(); await settle();
    expect(calls.map(command => command.name)).toEqual(['begin_taskbar_drag', 'end_taskbar_drag']);
  });

});
