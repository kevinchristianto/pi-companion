import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
import { nativePlatform } from '../../src/platform';

beforeEach(() => { vi.clearAllMocks(); mocks.isTauri.mockReturnValue(true); });
describe('narrow native bridge', () => {
  it('subscribes only to complete companion-state events', async () => {
    const callback = vi.fn(); const off = vi.fn(); mocks.listen.mockResolvedValue(off);
    expect(await nativePlatform().subscribe(callback)).toBe(off);
    expect(mocks.listen.mock.calls[0][0]).toBe('companion-state');
    mocks.listen.mock.calls[0][1]({ payload: { sequence: 4 } }); expect(callback).toHaveBeenCalledWith({ sequence: 4 });
  });
  it('passes only explicitly supported commands and bounded arguments', async () => {
    const platform = nativePlatform();
    await platform.getState(); await platform.command({ name: 'set_pinned', args: { pinned: true } });
    await platform.command({ name: 'set_click_through', args: { enabled: false } });
    await platform.command({ name: 'resize_window', args: { preset: 'wide' } });
    await platform.command({ name: 'set_window_mode', args: { mode: 'taskbar' } });
    await platform.command({ name: 'set_window_mode', args: { mode: 'office' } });
    await platform.command({ name: 'hide_window' }); await platform.command({ name: 'start_dragging' });
    expect(mocks.invoke.mock.calls).toEqual([['get_state'], ['set_pinned', { pinned: true }], ['set_click_through', { enabled: false }], ['resize_window', { preset: 'wide' }], ['set_window_mode', { mode: 'taskbar' }], ['set_window_mode', { mode: 'office' }], ['hide_window'], ['start_dragging']]);
  });
  it('has no silent sample-data fallback outside the explicitly enabled fixture', async () => {
    mocks.isTauri.mockReturnValue(false); const platform = nativePlatform();
    await expect(platform.getState()).rejects.toThrow('Browser preview has no live connection');
    await expect(platform.subscribe(() => {})).rejects.toThrow('Open Pi companion');
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.listen).not.toHaveBeenCalled(); expect(platform.review).toBe(false);
  });
});

describe('taskbar placement command boundary', () => {
  it('passes the exact native placement, count and cursor-sampled drag contract', async () => {
    const platform = nativePlatform();
    await platform.command({ name: 'set_taskbar_alignment', args: { alignment: 'right' } });
    await platform.command({ name: 'set_taskbar_position', args: { position: 0.25 } });
    await platform.command({ name: 'set_taskbar_content_count', args: { count: 64 } });
    for (const name of ['begin_taskbar_drag', 'update_taskbar_drag', 'end_taskbar_drag'] as const) await platform.command({ name });
    expect(mocks.invoke.mock.calls).toEqual([['set_taskbar_alignment', { alignment: 'right' }], ['set_taskbar_position', { position: 0.25 }], ['set_taskbar_content_count', { count: 64 }], ['begin_taskbar_drag'], ['update_taskbar_drag'], ['end_taskbar_drag']]);
  });
  it('rejects nonfinite, fractional and out-of-range arguments before IPC', async () => {
    const platform = nativePlatform();
    for (const count of [-1, 65, 0.5, NaN, Infinity]) await expect(platform.command({ name: 'set_taskbar_content_count', args: { count } })).rejects.toThrow('Invalid taskbar content count');
    for (const position of [-0.01, 1.01, NaN, Infinity]) await expect(platform.command({ name: 'set_taskbar_position', args: { position } })).rejects.toThrow('Invalid taskbar position');
    await expect(platform.command({ name: 'set_taskbar_alignment', args: { alignment: 'free' as never } })).rejects.toThrow('Invalid taskbar alignment');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
