import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderScheduler } from '../../src/scheduler';

describe('one independent, pausable render clock', () => {
  beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
  it('runs one capped timer regardless of repeated start calls', () => {
    const draw = vi.fn(); const clock = new RenderScheduler(draw);
    clock.start(); clock.start(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000); expect(draw).toHaveBeenCalledTimes(9); expect(vi.getTimerCount()).toBe(1);
    clock.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses without aging animation time or scheduling background work', () => {
    const draw = vi.fn(); const clock = new RenderScheduler(draw);
    clock.start(); vi.advanceTimersByTime(250); clock.stop(); const calls = draw.mock.calls.length;
    vi.advanceTimersByTime(10000); expect(draw).toHaveBeenCalledTimes(calls); expect(vi.getTimerCount()).toBe(0);
    clock.start(); expect(draw.mock.lastCall?.[0]).toBe(250); clock.dispose();
  });
  it('supports a single static repaint without starting a timer', () => {
    const draw = vi.fn(); const clock = new RenderScheduler(draw); clock.paint();
    expect(draw).toHaveBeenCalledWith(0); expect(vi.getTimerCount()).toBe(0);
  });
});
