import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import type { AppHandle } from '../../src/app';
import { ASSET_URLS } from '../../src/sprites';
import type { SpriteAssets } from '../../src/sprites';
import { agent, state, TestPlatform } from './helpers';

const assets = Object.fromEntries(Object.keys(ASSET_URLS).map(key => [key, {}])) as SpriteAssets;
let app: AppHandle | undefined;
let platform: TestPlatform;
let root: HTMLDivElement;
let reduced = false;
let mediaListener: (() => void) | undefined;
// Radix defers focus restoration; settle that work without advancing the 125ms sprite clock.
const settle = () => { act(() => { vi.advanceTimersByTime(1); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); settle(); };
const interact = (fn: () => void) => { act(fn); settle(); };
const click = (node: HTMLElement) => interact(() => node.click());
const key = (node: Element, key: string) => interact(() => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
const emit = (value: unknown) => interact(() => platform.emit(value));
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>('button,[role^="menuitem"]')].find(node => node.textContent?.trim() === text)!;
const menuButton = () => root.querySelector<HTMLButtonElement>('[aria-label="Office options"]')!;
const menu = () => document.querySelector<HTMLElement>('.office-menu');
const openMenu = () => { if (!menu()) { interact(() => menuButton().focus()); key(menuButton(), 'ArrowDown'); } };
const menuItem = (text: string) => { openMenu(); return byText(text); };
const choose = (label: string, choice: string) => {
  openMenu();
  const group = document.querySelector<HTMLElement>(`[aria-label="${label}"][role="group"]`)!;
  const item = [...group.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.querySelector('.option-label')?.textContent === choice || node.textContent?.trim() === choice)!;
  expect(item, `Missing ${label} option ${choice}`).toBeDefined(); click(item);
};
const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.agent-button')];
const start = async (assetsPromise = Promise.resolve(assets)) => { await act(async () => { app = createApp(root, platform, assetsPromise); await app.ready; }); settle(); };
const openGuide = () => { openMenu(); click(byText('Connection guide') || byText('Connect Pi')); };
const disabled = (node: HTMLElement) => node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true';

beforeEach(() => {
  vi.useFakeTimers(); document.body.replaceChildren(); root = document.createElement('div'); document.body.append(root);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  reduced = false; mediaListener = undefined;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, callback: () => void) => { mediaListener = callback; }, removeEventListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn(), imageSmoothingEnabled: true } as unknown as CanvasRenderingContext2D);
  platform = new TestPlatform();
});
afterEach(() => { act(() => app?.dispose()); app = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('semantic popup roster', () => {
  it('renders names and state in HTML with decorative-only canvas', async () => {
    platform.current = state([agent(0, { name: 'Workshop lead', state: 'working', tool: 'edit' }), agent(1, { state: 'waiting' })]); await start();
    expect(buttons()).toHaveLength(2); expect(buttons()[0].textContent).toContain('Workshop lead');
    expect(buttons()[0].getAttribute('aria-label')).toContain('Using edit');
    expect(root.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.querySelector('.sr-only[role="status"]')?.textContent).toContain('2 agents connected');
  });
  it('never turns server-provided text into HTML, URLs, or sprite paths', async () => {
    platform.current = state([agent(0, { name: '<img src=x onerror=alert(1)>', task: '<script>bad()</script>' })]); await start();
    click(buttons()[0]); expect(root.querySelector('img,script')).toBeNull();
    expect(root.querySelector('.detail-task')?.textContent).toBe('<script>bad()</script>');
  });
  it('keeps connected idle agents without a frontend liveness/activity timer', async () => {
    await start(); const reads = platform.reads;
    interact(() => vi.advanceTimersByTime(60000)); expect(buttons()).toHaveLength(1); expect(platform.reads).toBe(reads);
    emit(state([], 2)); expect(buttons()).toHaveLength(0);
  });
  it('keeps existing nodes and keyboard focus across ordinary snapshots', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const first = buttons()[0]; interact(() => first.focus());
    emit(state([agent(0, { state: 'working' }), agent(1)], 2));
    expect(buttons()[0]).toBe(first); expect(document.activeElement).toBe(first);
  });
  it('keeps keyboard focus when a snapshot reorders the focused resident', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const second = buttons()[1]; interact(() => second.focus());
    emit(state([agent(1), agent(0)], 2));
    expect(buttons()[0]).toBe(second); expect(document.activeElement).toBe(second);
  });
  it('subscribes before the initial read and ignores a late older response', async () => {
    let resolveRead!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    act(() => { app = createApp(root, platform, Promise.resolve(assets)); }); await flush();
    emit(state([agent(2)], 3));
    await act(async () => { resolveRead(state([agent(1)], 2)); await app!.ready; });
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 2');
  });
  it('keeps a newer authoritative event when the initial read fails late', async () => {
    let rejectRead!: (reason: unknown) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
    act(() => { app = createApp(root, platform, Promise.resolve(assets)); }); await flush();
    emit(state([agent(2)], 3));
    await act(async () => { rejectRead(new Error('Old read failed')); await app!.ready; });
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 2');
  });
  it('handles selection, close, Escape, and selected-agent removal without trapped focus', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const first = buttons()[0]; click(first); expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement?.id).toBe('detail-title');
    click(byText('Close details')); expect(document.activeElement).toBe(first);
    click(first); key(document.activeElement!, 'Escape');
    expect(document.activeElement).toBe(first); expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(true);
    click(first); emit(state([agent(1)], 2)); expect(document.activeElement).toBe(buttons()[0]);
    expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(true);
  });
  it('moves focus to a surviving resident or menu when a focused agent is removed', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    interact(() => buttons()[0].focus()); emit(state([agent(1)], 2)); expect(document.activeElement).toBe(buttons()[0]);
    interact(() => buttons()[0].focus()); emit(state([], 3)); expect(document.activeElement).toBe(menuButton());
  });
  it('hides all agents on malformed/disconnected data and rejects stale revival', async () => {
    await start(); emit({ wrong: true }); expect(buttons()).toHaveLength(0);
    emit(state()); expect(buttons()).toHaveLength(0);
    emit(state([agent()], 2)); expect(buttons()).toHaveLength(1);
    const disconnected = state([agent()], 3); disconnected.bridge.status = 'error'; emit(disconnected);
    expect(buttons()).toHaveLength(0); expect(root.textContent).toContain('No agents are shown');
  });
  it('caps illustrated agents at 64 while retaining the entire accessible office roster', async () => {
    platform.current = state(Array.from({ length: 80 }, (_, i) => agent(i))); await start();
    expect(buttons()).toHaveLength(80); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(64);
    expect(root.querySelector('.capacity')?.textContent).toContain('remaining 16');
    expect(byText('List')).toBeUndefined(); expect(byText('Office')).toBeUndefined();
    expect(root.querySelectorAll('.agent.text-only')).toHaveLength(16);
  });
  it('discloses authoritative backend overflow in the office', async () => {
    platform.current.snapshot.omittedAgentCount = 9; await start();
    expect(root.querySelector('.capacity')?.textContent).toContain('omitted 9 additional agents');
  });
  it('groups every session in the same exact workspace and resets when its last agent disconnects', async () => {
    platform.current = state([agent(0, { cwd: '/work/companion' }), agent(1, { cwd: '/work/companion', sessionId: 'second', sessionName: 'Second session' }), agent(2, { cwd: '/work/other' })]); await start();
    choose('Project or workspace', 'companion');
    expect(buttons()).toHaveLength(2); expect(buttons()[1].textContent).toContain('Second session');
    emit(state([agent(1, { cwd: '/work/companion', sessionId: 'second' }), agent(2, { cwd: '/work/other' })], 2));
    expect(buttons()).toHaveLength(1); expect(root.querySelector('.current-project')?.textContent).toBe('companion');
    emit(state([agent(2, { cwd: '/work/other' })], 3));
    expect(root.querySelector('.current-project')?.textContent).toBe('All projects'); expect(buttons()).toHaveLength(1);
    emit(state([agent(0, { cwd: '/work/companion' }), agent(2, { cwd: '/work/other' })], 4));
    expect(buttons()).toHaveLength(2); choose('Project or workspace', 'companion'); expect(buttons()).toHaveLength(1);
  });
  it('keeps keyboard focus in the menu when its focused workspace disappears', async () => {
    platform.current = state([agent(0, { cwd: '/work/companion' }), agent(1, { cwd: '/work/other' })]); await start(); openMenu();
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(node => node.querySelector('.option-label')?.textContent === 'companion')!;
    interact(() => option.focus()); key(option, 'Enter'); expect(menu()).not.toBeNull();
    emit(state([agent(1, { cwd: '/work/other' })], 2));
    expect(root.querySelector('.current-project')?.textContent).toBe('All projects');
    expect(menu()!.contains(document.activeElement)).toBe(true); key(document.activeElement!, 'Escape');
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(menuButton());
  });
  it('shows useful text-only rows if any required artwork fails to load', async () => {
    await start(Promise.reject(new Error('Missing foreground')));
    expect(buttons()).toHaveLength(1); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(0);
    expect(root.querySelector('.art-warning')?.textContent).toContain('could not be loaded');
  });
});

describe('animation and native controls', () => {
  it('uses one animation timer and pauses for hidden pages, reduced motion, and explicit pause', async () => {
    await start(); expect(vi.getTimerCount()).toBe(1);
    click(menuItem('Pause motion')); expect(vi.getTimerCount()).toBe(0);
    click(menuItem('Resume motion')); expect(vi.getTimerCount()).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); interact(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    platform.current = state([agent()], 2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); interact(() => document.dispatchEvent(new Event('visibilitychange'))); await flush();
    expect(vi.getTimerCount()).toBe(1);
    reduced = true; interact(() => mediaListener?.()); expect(vi.getTimerCount()).toBe(0); expect(disabled(menuItem('Reduced motion'))).toBe(true);
  });
  it('keeps restoration fail-closed until a fresh authoritative snapshot arrives', async () => {
    await start();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); interact(() => document.dispatchEvent(new Event('visibilitychange')));
    let resolveRead!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); interact(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(buttons()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect(root.textContent).toContain('Refreshing the live connection');
    await act(async () => resolveRead(state([agent(3)], 2))); await flush();
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 3'); expect(vi.getTimerCount()).toBe(1);
  });
  it('does not erase a newer live event when an older restore read rejects', async () => {
    await start();
    let rejectRead!: (reason: unknown) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
    interact(() => document.dispatchEvent(new Event('visibilitychange'))); expect(buttons()).toHaveLength(0);
    emit(state([agent(4)], 2)); await act(async () => rejectRead(new Error('Older restore failed'))); await flush();
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 4'); expect(vi.getTimerCount()).toBe(1);
  });
  it('uses one intersection observer and stops when every illustrated tile is offscreen', async () => {
    let callback: IntersectionObserverCallback | undefined; const observe = vi.fn(); const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(fn: IntersectionObserverCallback) { callback = fn; } observe = observe; unobserve = vi.fn(); disconnect = disconnect; });
    await start(); expect(observe).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    const entry = { target: root.querySelector('.agent')!, isIntersecting: true } as IntersectionObserverEntry;
    interact(() => callback!([entry], {} as IntersectionObserver)); expect(vi.getTimerCount()).toBe(1);
    interact(() => callback!([{ ...entry, isIntersecting: false }], {} as IntersectionObserver)); expect(vi.getTimerCount()).toBe(0);
    interact(() => { app!.dispose(); app = undefined; });
    expect(disconnect).toHaveBeenCalledOnce();
    interact(() => callback!([entry], {} as IntersectionObserver)); expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves observed visible sprites across menu updates and authoritative snapshots', async () => {
    let callback: IntersectionObserverCallback | undefined; const observe = vi.fn(); const unobserve = vi.fn(); const construct = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(fn: IntersectionObserverCallback) { construct(); callback = fn; } observe = observe; unobserve = unobserve; disconnect = vi.fn(); });
    await start(); const tile = root.querySelector('.agent')!;
    interact(() => callback!([{ target: tile, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    observe.mockClear(); unobserve.mockClear(); openMenu();
    expect(vi.getTimerCount()).toBe(1); expect(unobserve).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled();
    emit(state([agent(0, { state: 'working' })], 2));
    expect(vi.getTimerCount()).toBe(1); expect(unobserve).not.toHaveBeenCalled(); expect(observe).not.toHaveBeenCalled(); expect(construct).toHaveBeenCalledOnce();
  });
  it('updates 1x/2x backing-store sizes without fractional fitting', async () => {
    await start(); expect(root.querySelector('canvas')?.width).toBe(128);
    choose('Artwork scale', '1× · small'); expect(root.querySelector('canvas')?.width).toBe(64);
    choose('Artwork scale', '2× · original'); expect(root.querySelector('canvas')?.width).toBe(128);
  });
  it('uses only named commands and reflects authoritative pin state', async () => {
    await start(); click(menuItem('Pin')); await flush();
    expect(platform.commands).toEqual([{ name: 'set_pinned', args: { pinned: true } }]);
    expect(menuItem('Pinned').getAttribute('aria-checked')).toBe('true');
    click(menuItem('Hide')); await flush(); expect(platform.commands.at(-1)).toEqual({ name: 'hide_window' });
  });
  it('keeps truthful state and useful feedback when a window command fails', async () => {
    await start(); platform.failure = new Error('Native pin failed'); click(menuItem('Pin')); await flush();
    expect(menuItem('Pin').getAttribute('aria-checked')).toBe('false'); expect(root.querySelector('.command-feedback')?.textContent).toBe('Native pin failed');
  });
  it('rejects duplicate pending commands and waits for authoritative pin state', async () => {
    await start(); let resolveCommand!: (value: unknown) => void;
    const command = vi.spyOn(platform, 'command').mockImplementation(() => new Promise(resolve => { resolveCommand = resolve; }));
    click(menuItem('Pin')); expect(disabled(menuItem('Pin'))).toBe(true); click(byText('Pin')); expect(command).toHaveBeenCalledOnce();
    expect(byText('Pin').getAttribute('aria-checked')).toBe('false');
    const pinned = state([agent()], 2); pinned.window.pinned = true;
    await act(async () => resolveCommand(pinned)); await flush();
    expect(byText('Pinned').getAttribute('aria-checked')).toBe('true'); expect(disabled(byText('Pinned'))).toBe(false);
  });
  it('keeps a newer recovery event authoritative when a pass-through command resolves late', async () => {
    await start(); let resolveCommand!: (value: unknown) => void;
    vi.spyOn(platform, 'command').mockImplementation(() => new Promise(resolve => { resolveCommand = resolve; }));
    click(menuItem('Pass through'));
    emit(state([agent()], 3));
    const stale = state([agent()], 2); stale.window.clickThrough = true;
    await act(async () => resolveCommand(stale)); await flush();
    expect(menuItem('Pass through').getAttribute('aria-checked')).toBe('false');
    expect(root.querySelector('.command-feedback')?.textContent || '').not.toContain('Pass-through is on');
  });
  it('clears the pass-through notice after authoritative input recovery', async () => {
    await start(); click(menuItem('Pass through')); await flush();
    expect(root.querySelector('.command-feedback')?.textContent).toContain('Pass-through is on');
    emit(state([agent()], 3));
    expect(root.querySelector('.command-feedback')?.textContent || '').not.toContain('Pass-through is on');
  });
  it('uses supported size presets and keeps the previous preset on native failure', async () => {
    await start(); choose('Window size', 'Wide'); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'resize_window', args: { preset: 'wide' } });
    platform.failure = new Error('Cannot resize'); choose('Window size', 'Tall'); await flush();
    openMenu(); expect(document.querySelector('[aria-label="Window size"] [aria-checked="true"]')?.textContent).toBe('Wide');
    expect(root.querySelector('.command-feedback')?.textContent).toBe('Cannot resize');
  });
  it('disables hide and pass-through unless native recovery is available', async () => {
    platform.current.window.recoveryAvailable = false; await start();
    expect(disabled(menuItem('Hide'))).toBe(true); expect(disabled(menuItem('Pass through'))).toBe(true);
    click(byText('Hide')); click(byText('Pass through')); expect(platform.commands).toEqual([]);
  });
  it('removes subscriptions, document listeners, and all scheduled work on disposal', async () => {
    await start(); interact(() => { app!.dispose(); app = undefined; });
    expect(platform.unsubscribed).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(root.childElementCount).toBe(0);
    const reads = platform.reads; interact(() => document.dispatchEvent(new Event('visibilitychange'))); expect(platform.reads).toBe(reads);
    emit(state([agent(9)], 4)); expect(root.childElementCount).toBe(0);
  });
  it('cleans up a subscription that finishes after disposal without requesting state', async () => {
    let resolveSubscribe!: (unsubscribe: () => void) => void; const unsubscribe = vi.fn();
    vi.spyOn(platform, 'subscribe').mockImplementation(() => new Promise(resolve => { resolveSubscribe = resolve; }));
    act(() => { app = createApp(root, platform, Promise.resolve(assets)); app.dispose(); });
    await act(async () => { resolveSubscribe(unsubscribe); await app!.ready; }); app = undefined; settle();
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(platform.reads).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('one-time Pi connection setup', () => {
  it('provides a selectable JSON settings entry without per-session setup or credential data', async () => {
    const path = 'C:\\Users\\Zoë Work\\AppData\\Roaming\\Pi Companion\\observer\\index.ts';
    platform.current.bridge.observerEntry = path; await start(); openGuide();
    const entry = document.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(JSON.parse(entry.value)).toEqual({ extensions: [path] }); expect(entry.readOnly).toBe(true);
    expect(document.querySelector('.guide')?.textContent).toContain('existing extensions array');
    expect(document.querySelector('.guide')?.textContent).toContain('/reload');
    expect(document.querySelector('.guide')?.textContent).not.toContain('PI_COMPANION_CONNECTION_FILE');
    expect(document.querySelector('.guide')?.textContent).not.toContain('--extension');
    expect(document.querySelector('.guide')?.textContent).not.toContain('/local/config/connection.json');
    click(byText('Select config entry')); expect(document.activeElement).toBe(entry);
    expect(entry.selectionStart).toBe(0); expect(entry.selectionEnd).toBe(entry.value.length); expect(platform.commands).toEqual([]);
  });
  it('does not invent an observer path before a verified native export is available', async () => {
    await start(); openGuide();
    const entry = document.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(entry.value).toBe(''); expect(disabled(byText('Select config entry'))).toBe(true);
    const available = state([], 2); available.bridge.observerEntry = '/relocated/私の profile/observer/index.ts'; emit(available);
    expect(JSON.parse(entry.value)).toEqual({ extensions: ['/relocated/私の profile/observer/index.ts'] });
    expect(disabled(byText('Select config entry'))).toBe(false);
    emit(state([], 3)); expect(entry.value).toBe(''); expect(disabled(byText('Select config entry'))).toBe(true);
  });
  it('encodes quoted path characters as JSON and never treats them as HTML', async () => {
    const path = '/private/<img src=x>/a"quoted/observer/index.ts';
    platform.current.bridge.observerEntry = path; await start(); openGuide();
    const entry = document.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(JSON.parse(entry.value).extensions).toEqual([path]); expect(document.querySelector('img, script')).toBeNull();
  });
});

describe('compact options menu', () => {
  it('keeps every option under one button and never renders native selects or list switches', async () => {
    await start(); expect(menu()).toBeNull(); expect(document.querySelectorAll('select')).toHaveLength(0);
    openMenu();
    for (const label of ['Pin', 'Pass through', 'Hide', 'Pause motion', 'Connection guide']) expect(menu()!.contains(byText(label))).toBe(true);
    expect(root.querySelector('.toolbar,.footer,.segmented')).toBeNull(); expect(byText('List')).toBeUndefined(); expect(byText('Office')).toBeUndefined();
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'); expect(document.activeElement?.textContent).toContain('All projects');
    key(document.activeElement!, 'Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(menuButton());
  });
  it('supports keyboard navigation, Escape, and outside dismissal without focus traps', async () => {
    await start(); openMenu(); const first = document.activeElement as HTMLElement;
    key(first, 'ArrowDown'); expect(document.activeElement).not.toBe(first);
    key(document.activeElement!, 'End'); expect(document.activeElement?.textContent).toBe('Connection guide');
    key(document.activeElement!, 'Home'); expect(document.activeElement).toBe(first);
    key(first, 'Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(menuButton());
    openMenu(); interact(() => root.querySelector('.workspace')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(menu()).toBeNull();
    openMenu(); interact(() => buttons()[0].focus()); expect(menu()).toBeNull(); expect(document.activeElement).toBe(buttons()[0]);
  });
  it('closes the menu before native pass-through/hide and retains recovery guards across events', async () => {
    await start(); click(menuItem('Pass through')); expect(menu()).toBeNull(); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_click_through', args: { enabled: true } });
    const unsafe = state([agent()], 8); unsafe.window.recoveryAvailable = false; emit(unsafe);
    expect(disabled(menuItem('Hide'))).toBe(true); expect(disabled(menuItem('Pass through'))).toBe(true);
  });
  it('does not drag the native window when operating menu controls', async () => {
    await start(); openMenu();
    interact(() => byText('Pin').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    interact(() => menu()?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(platform.commands).toEqual([]);
    interact(() => root.querySelector('.brand')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })));
    expect(platform.commands).toEqual([{ name: 'start_dragging' }]);
  });
  it('closes settings for the connection dialog and restores focus after dismissal', async () => {
    await start(); openGuide(); expect(menu()).toBeNull(); expect(document.querySelector('.guide[role="dialog"]')).not.toBeNull();
    click(byText('Got it')); expect(document.querySelector('.guide')).toBeNull(); expect(document.activeElement).toBe(menuButton());
    openGuide(); key(document.activeElement!, 'Escape'); expect(document.querySelector('.guide')).toBeNull(); expect(document.activeElement).toBe(menuButton());
    openGuide(); const overlay = document.querySelector('.guide')!.previousElementSibling as HTMLElement;
    interact(() => { overlay.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 })); overlay.click(); });
    expect(document.querySelector('.guide')).toBeNull(); expect(document.activeElement).toBe(menuButton());
  });
});
