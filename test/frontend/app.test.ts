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
  it('keeps long agent details scrollable and closes back to the selected agent', async () => {
    const task = 'A long task description with preserved line breaks.\n'.repeat(60);
    const name = 'Long agent name '.repeat(15);
    platform.current = state([agent(0, { name, task, cwd: '/work/' + 'long-project-name/'.repeat(12) })]);
    await start(); const selected = buttons()[0]; click(selected);
    const details = root.querySelector<HTMLElement>('.detail')!;
    expect(details.getAttribute('aria-labelledby')).toBe('detail-title');
    expect(details.querySelector('#detail-title')?.textContent).toBe(name);
    expect(details.querySelector('.detail-task')?.textContent).toBe(task);
    interact(() => { details.scrollTop = 500; details.dispatchEvent(new Event('scroll')); });
    expect(details.querySelector('.detail-head')?.contains(byText('Close details'))).toBe(true);
    click(byText('Close details')); expect(details.hidden).toBe(true);
    expect(document.activeElement).toBe(selected);
    click(selected); key(document.activeElement!, 'Escape');
    expect(details.hidden).toBe(true); expect(document.activeElement).toBe(selected);
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
    expect(buttons()).toHaveLength(2); expect(buttons()[1].getAttribute('aria-label')).toContain('Second session');
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
    await start(); expect(root.querySelector('canvas')?.width).toBe(64);
    choose('Artwork scale', '2× · original'); expect(root.querySelector('canvas')?.width).toBe(128);
    choose('Artwork scale', '1× · small'); expect(root.querySelector('canvas')?.width).toBe(64);
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
  it('keeps decorative border overlays out of the scrolling menu content', async () => {
    await start(); openMenu();
    const content = menu()!;
    // Borders on absolutely positioned child boxes move across options while scrolling.
    expect(content.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
    for (const scrollTop of [0, 80, 180, 360, 0]) {
      interact(() => { content.scrollTop = scrollTop; content.dispatchEvent(new Event('scroll')); });
      expect(content.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
      expect(content.contains(byText('2× · original'))).toBe(true);
      expect(content.contains(byText('Hide'))).toBe(true);
    }
    choose('Artwork scale', '2× · original');
    expect(content.querySelector('[aria-label="Artwork scale"] [data-state="checked"]')?.textContent).toContain('2×');
    key(document.activeElement!, 'Escape');
    expect(menu()).toBeNull(); expect(document.activeElement).toBe(menuButton());
  });

  it('keeps every option under one button and never renders native selects or list switches', async () => {
    await start(); expect(menu()).toBeNull(); expect(document.querySelectorAll('select')).toHaveLength(0);
    openMenu();
    for (const label of ['Pin', 'Pass through', 'Hide', 'Pause motion', 'Connection guide']) expect(menu()!.contains(byText(label))).toBe(true);
    expect(root.querySelector('.toolbar,.footer,.segmented')).toBeNull(); expect(byText('List')).toBeUndefined(); expect(menu()!.contains(byText('Office'))).toBe(true);
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
  it('keeps the scrollable connection guide free of decorative border overlays', async () => {
    platform.current.bridge.observerEntry = '/private/companion/observer/index.ts';
    await start(); openGuide();
    const guide = document.querySelector<HTMLElement>('.guide[role="dialog"]')!;
    expect(guide.querySelectorAll(':scope > [aria-hidden="true"]')).toHaveLength(0);
    interact(() => { guide.scrollTop = 180; guide.dispatchEvent(new Event('scroll')); });
    expect(guide.querySelector('textarea')?.value).toContain('extensions');
    click(byText('Got it')); expect(document.querySelector('.guide')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
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

describe('transparent taskbar desk strip', () => {
  const officeReturn = () => root.querySelector<HTMLButtonElement>('.strip-return')!;
  const enterTaskbar = async () => { choose('Window mode', 'Taskbar'); await flush(); };
  const nativeUpdate = (patch: Partial<ReturnType<typeof state>['window']>, agents = platform.current.snapshot.agents) => {
    platform.current = { ...platform.current, sequence: platform.current.sequence + 1, snapshot: { ...platform.current.snapshot, agents }, window: { ...platform.current.window, ...patch } };
    emit(platform.current);
  };
  it('switches with one named mode command, keeps the same roster, and returns through the compact Office button', async () => {
    await start(); const tile = buttons()[0]; const workspace = root.querySelector('.workspace');
    await enterTaskbar();
    expect(platform.commands).toEqual([{ name: 'set_window_mode', args: { mode: 'taskbar' } }, { name: 'set_taskbar_content_count', args: { count: 1 } }]);
    expect(root.querySelector('main')?.dataset.mode).toBe('taskbar'); expect(document.documentElement.dataset.windowMode).toBe('taskbar');
    expect(root.querySelector('.workspace')).toBe(workspace); expect(buttons()[0]).toBe(tile);
    expect(root.querySelector('.titlebar,.summary,.review-banner')).toBeNull(); expect(menu()).toBeNull();
    expect(root.querySelector('.roster')?.getAttribute('data-view')).toBe('taskbar');
    expect(root.querySelector('.workspace')?.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(officeReturn());
    click(officeReturn()); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_window_mode', args: { mode: 'office' } });
    expect(root.querySelector('main')?.dataset.mode).toBe('office'); expect(root.querySelector('.strip-controls')).toBeNull();
    expect(buttons()[0]).toBe(tile); expect(document.activeElement).toBe(menuButton());
  });
  it('always renders each status as a speech bubble above its desk, with names in pixel hover content and aria', async () => {
    platform.current = state([
      agent(0, { state: 'working', tool: 'a_long_tool_name_that_must_not_replace_the_visible_state' }),
      agent(1, { state: 'thinking' }), agent(2, { state: 'waiting' }), agent(3, { state: 'idle' }),
      agent(4, { state: 'error' }), agent(5, { state: 'completed' }), agent(6, { state: 'unknown' }),
    ]); platform.current.window.mode = 'taskbar'; await start();
    expect(buttons().map(button => button.querySelector('.status-bubble')?.textContent)).toEqual(['Working', 'Thinking', 'Needs input', 'Ready', 'Error', 'Completed', 'Unknown']);
    for (const button of buttons()) {
      expect(button.firstElementChild?.className).toBe('status-bubble');
      expect(button.querySelector('.status-bubble')?.nextElementSibling?.tagName).toBe('CANVAS');
      expect(button.querySelector('.status-bubble > .taskbar-bubble-body')?.textContent).toBe(button.querySelector('.status-bubble')?.textContent);
      expect(button.querySelectorAll('.status-bubble')).toHaveLength(1); expect(button.querySelector('.status-bubble')?.hasAttribute('hidden')).toBe(false);
      expect(button.querySelector('canvas')?.width).toBe(64); expect(button.querySelector('.agent-name,.agent-copy')).toBeNull();
      expect(button.querySelector('.strip-agent-name')?.textContent).toContain('Agent'); expect(button.querySelector('.strip-agent-name')?.getAttribute('aria-hidden')).toBe('true');
    }
    expect(buttons()[0].getAttribute('aria-label')).toContain('Agent 0');
    expect(buttons()[0].getAttribute('aria-label')).toContain('Using a_long_tool_name_that_must_not_replace_the_visible_state');
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
  it('removes redundant session labels in both modes while keeping accessible session context and details', async () => {
    platform.current = state([agent(0, { name: 'Project lead', sessionName: 'Pi session #42' })]); await start();
    expect(root.querySelector('.agent-session')).toBeNull(); expect(buttons()[0].textContent).not.toContain('Pi session');
    expect(buttons()[0].getAttribute('aria-label')).toContain('Pi session #42');
    click(buttons()[0]); expect(root.querySelector('.detail-fields')?.textContent).toContain('SessionPi session #42');
    await enterTaskbar();
    expect(root.querySelector('.agent-session')).toBeNull(); expect(buttons()[0].querySelector('.agent-name')).toBeNull();
    expect(buttons()[0].querySelector('.strip-agent-name')?.textContent).toBe('Project lead');
    expect(buttons()[0].getAttribute('aria-label')).toContain('Pi session #42');
    expect(root.querySelector<HTMLDivElement>('.detail')?.hidden).toBe(true);
    click(buttons()[0]); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_window_mode', args: { mode: 'office' } });
    expect(root.querySelector<HTMLDivElement>('.detail')?.hidden).toBe(false);
    expect(root.querySelector('.detail-fields')?.textContent).toContain('SessionPi session #42');
    expect(document.activeElement?.id).toBe('detail-title');
  });
  it('keeps exact-workspace filters, artwork scale, and motion choices across mode switches', async () => {
    platform.current = state([agent(0, { cwd: '/work/project' }), agent(1, { cwd: '/work/project', sessionId: 'second' }), agent(2, { cwd: '/other/project' })]); await start();
    choose('Project or workspace', 'project · /work/project'); choose('Artwork scale', '2× · original'); click(menuItem('Pause motion'));
    await enterTaskbar();
    expect(buttons()).toHaveLength(2); expect(root.querySelector('.strip-project')?.getAttribute('title')).toBe('/work/project');
    expect(root.querySelector('canvas')?.width).toBe(64); expect(vi.getTimerCount()).toBe(0);
    click(officeReturn()); await flush(); openMenu();
    expect(root.querySelector('canvas')?.width).toBe(128); expect(root.querySelector('main')?.dataset.scale).toBe('2');
    expect(document.querySelector('[aria-label="Artwork scale"] [aria-checked="true"]')?.textContent).toContain('2×');
    expect(document.querySelector('[aria-label="Project or workspace"] [aria-checked="true"] .option-label')?.textContent).toBe('project · /work/project');
    expect(byText('Resume motion')).toBeDefined(); expect(root.querySelector('.current-project')?.textContent).toBe('project');
  });
  it('retains the selected workspace across a fail-closed visibility refresh, then reconciles a confirmed disappearance', async () => {
    platform.current = state([agent(0, { cwd: '/work/companion' }), agent(1, { cwd: '/work/other' })]); await start();
    choose('Project or workspace', 'companion'); await enterTaskbar();
    let resolve!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise(done => { resolve = done; }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); interact(() => document.dispatchEvent(new Event('visibilitychange')));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); interact(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(buttons()).toHaveLength(0);
    platform.current = { ...platform.current, sequence: platform.current.sequence + 1 };
    await act(async () => resolve(platform.current)); await flush();
    expect(buttons()).toHaveLength(1); expect(root.querySelector('.strip-project')?.textContent).toBe('companion');
    nativeUpdate({}, [agent(1, { cwd: '/work/other' })]);
    expect(buttons()).toHaveLength(1); expect(root.querySelector('.strip-project')?.textContent).toBe('All projects');
  });
  it.each([false, undefined])('requires independent recovery before entering taskbar (availability %s)', async recoveryAvailable => {
    platform.current.window.recoveryAvailable = recoveryAvailable; await start();
    expect(disabled(menuItem('Taskbar'))).toBe(true); click(byText('Taskbar')); await flush();
    expect(platform.commands).toEqual([]); expect(root.querySelector('main')?.dataset.mode).toBe('office');
  });
  it('keeps explicit pass-through unchanged on mode changes and follows authoritative shortcut recovery', async () => {
    platform.current.window.clickThrough = true; await start(); await enterTaskbar();
    expect(platform.current.window.clickThrough).toBe(true); expect(root.querySelector('.strip-notice')?.textContent).toContain('Pass-through is on');
    expect(platform.commands.every(command => command.name === 'set_window_mode' || command.name === 'set_taskbar_content_count')).toBe(true);
    nativeUpdate({ mode: 'office', clickThrough: false, fullscreenHidden: false });
    expect(root.querySelector('main')?.dataset.mode).toBe('office'); expect(root.querySelector('.command-feedback')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });
  it.each(['menu', 'guide', 'details'])('releases %s focus and removes clipped panels on a native taskbar change', async panel => {
    await start();
    if (panel === 'menu') openMenu(); else if (panel === 'guide') openGuide(); else click(buttons()[0]);
    nativeUpdate({ mode: 'taskbar' }); await flush();
    expect(menu()).toBeNull(); expect(document.querySelector('.guide,[data-slot="dialog-overlay"]')).toBeNull();
    expect(root.querySelector<HTMLElement>('.detail')?.hidden).toBe(true); expect(document.activeElement).toBe(officeReturn());
    expect(document.body.style.pointerEvents).not.toBe('none');
    nativeUpdate({ mode: 'office' }); await flush();
    expect(menu()).toBeNull(); expect(document.querySelector('.guide')).toBeNull(); expect(root.querySelector<HTMLElement>('.detail')?.hidden).toBe(true);
    expect(document.activeElement).toBe(menuButton());
  });
  it('shows command failures without leaving the authoritative mode and rejects repeated pending mode clicks', async () => {
    await start(); platform.failure = new Error('No taskbar work area is available'); await enterTaskbar();
    expect(root.querySelector('main')?.dataset.mode).toBe('office'); expect(root.querySelector('.command-feedback')?.textContent).toContain('No taskbar work area');
    platform.failure = undefined; await enterTaskbar();
    let resolve!: (value: unknown) => void;
    const command = vi.spyOn(platform, 'command').mockImplementation(() => new Promise(done => { resolve = done; }));
    click(officeReturn()); click(officeReturn()); expect(command).toHaveBeenCalledOnce(); expect(officeReturn().disabled).toBe(true);
    nativeUpdate({ mode: 'office', clickThrough: false });
    const stale = { ...platform.current, sequence: platform.current.sequence - 1, window: { ...platform.current.window, mode: 'taskbar' } };
    await act(async () => resolve(stale)); await flush();
    expect(root.querySelector('main')?.dataset.mode).toBe('office');
  });
  it('keeps taskbar live-only, removes disconnected agents and restores a fresh reconnect', async () => {
    platform.current = state([agent(0), agent(1, { state: 'offline' }), agent(2, { state: 'stale' })]); platform.current.window.mode = 'taskbar'; await start();
    expect(buttons()).toHaveLength(1); interact(() => buttons()[0].focus()); nativeUpdate({}, []);
    expect(buttons()).toHaveLength(0); expect(document.activeElement).toBe(officeReturn());
    expect(root.textContent).toContain('No connected agents');
    nativeUpdate({}, [agent(3)]); expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 3');
    emit({ ...platform.current, sequence: platform.current.sequence + 1, window: { ...platform.current.window, mode: 'invalid' } });
    expect(buttons()).toHaveLength(0); expect(root.textContent).toContain('invalid update');
    nativeUpdate({}, [agent(4)]); await flush(); expect(buttons()[0].textContent).toContain('Agent 4');
  });
  it('keeps names and statuses accessible when artwork is capped or unavailable', async () => {
    platform.current = state(Array.from({ length: 80 }, (_, index) => agent(index))); platform.current.window.mode = 'taskbar'; await start();
    expect(buttons()).toHaveLength(80); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(64);
    expect(root.querySelector('.strip-notice')?.textContent).toContain('all 80 agents');
    expect(buttons()[79].getAttribute('aria-label')).toContain('Agent 79, Ready, Workshop');
    interact(() => { app!.dispose(); app = undefined; }); await start(Promise.reject(new Error('Missing artwork')));
    expect(buttons()).toHaveLength(80); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(0);
    expect(root.querySelector('.strip-notice')?.textContent).toContain('Artwork unavailable'); expect(vi.getTimerCount()).toBe(0);
  });
  it('retains one observer/root across modes, pauses clipped desks/fullscreen, and disposes every sprite', async () => {
    const observed = new Set<Element>(); const construct = vi.fn(); const disconnect = vi.fn(); let callback!: IntersectionObserverCallback; let observerRoot: Element | Document | null | undefined;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(fn: IntersectionObserverCallback, options: IntersectionObserverInit) { construct(); callback = fn; observerRoot = options.root; }
      observe = (element: Element) => observed.add(element); unobserve = (element: Element) => observed.delete(element); disconnect = disconnect;
    });
    await start(); const tile = root.querySelector('.agent')!; const intersect = (isIntersecting: boolean) => interact(() => callback([{ target: tile, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver));
    expect(vi.getTimerCount()).toBe(0); intersect(true); expect(vi.getTimerCount()).toBe(1);
    await enterTaskbar(); expect(construct).toHaveBeenCalledOnce(); expect(observerRoot).toBe(root.querySelector('.workspace')); expect(observed.size).toBe(1);
    intersect(false); expect(vi.getTimerCount()).toBe(0); intersect(true); expect(vi.getTimerCount()).toBe(1);
    nativeUpdate({ fullscreenHidden: true }); expect(vi.getTimerCount()).toBe(0);
    nativeUpdate({ fullscreenHidden: false }); expect(vi.getTimerCount()).toBe(1);
    reduced = true; interact(() => mediaListener?.()); expect(vi.getTimerCount()).toBe(0);
    reduced = false; interact(() => mediaListener?.()); expect(vi.getTimerCount()).toBe(1);
    nativeUpdate({}, []); expect(observed.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    interact(() => { app!.dispose(); app = undefined; }); expect(disconnect).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.windowMode).toBeUndefined(); intersect(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('exposes actual pixel radio controls for alignment and preserves free placement across Office changes', async () => {
    await start(); choose('Taskbar alignment', 'Left'); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_taskbar_alignment', args: { alignment: 'left' } });
    expect(document.querySelector('[aria-label="Taskbar alignment"] [aria-checked="true"]')?.textContent).toBe('Left');
    expect(menu()).not.toBeNull(); expect(platform.commands.some(command => command.name === 'start_dragging')).toBe(false);
    choose('Taskbar alignment', 'Right'); await flush(); await enterTaskbar();
    const grip = root.querySelector<HTMLButtonElement>('.strip-drag')!;
    expect(grip.title).toBe(''); expect(grip.getAttribute('aria-describedby')).toBe('strip-move-help');
    key(grip, 'ArrowLeft'); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_taskbar_position', args: { position: 0.99 } });
    expect(platform.current.window.taskbarPlacement?.alignment).toBe('free');
    key(grip, 'Home'); await flush(); key(grip, 'ArrowLeft'); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_taskbar_position', args: { position: 0 } });
    key(grip, 'End'); await flush(); key(grip, 'ArrowRight'); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_taskbar_position', args: { position: 1 } });
    interact(() => grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }))); await flush();
    expect(platform.commands.at(-1)).toEqual({ name: 'set_taskbar_position', args: { position: 0.9 } });
    click(officeReturn()); await flush(); openMenu(); expect(menu()?.textContent).toContain('Free position.');
    expect(document.querySelector('[aria-label="Taskbar alignment"] [aria-checked="true"]')).toBeNull();
    choose('Taskbar alignment', 'Center'); await flush(); expect(platform.current.window.taskbarPlacement).toEqual({ alignment: 'center', position: 0.5 });
    key(document.activeElement!, 'Escape'); expect(menu()).toBeNull(); expect(document.activeElement).toBe(menuButton());
  });
  it('reports the filtered live roster count after content changes, disappearance and reconnect, bounded at64', async () => {
    const counts = () => platform.commands.filter(command => command.name === 'set_taskbar_content_count').map(command => command.args.count);
    platform.current = state([agent(0, { cwd: '/work/one' }), agent(1, { cwd: '/work/one' }), agent(2, { cwd: '/work/two' })]); await start();
    choose('Project or workspace', 'one'); await enterTaskbar(); expect(counts()).toEqual([2]);
    nativeUpdate({}, [agent(0, { cwd: '/work/one' }), agent(2, { cwd: '/work/two' })]); await flush(); expect(counts()).toEqual([2, 1]);
    nativeUpdate({}, [agent(2, { cwd: '/work/two' })]); await flush(); expect(root.querySelector('.strip-project')?.textContent).toBe('All projects'); expect(counts()).toEqual([2, 1]);
    platform.current.bridge.status = 'error'; nativeUpdate({}); await flush(); expect(counts()).toEqual([2, 1, 0]);
    platform.current.bridge.status = 'listening'; nativeUpdate({}, Array.from({ length: 80 }, (_, i) => agent(i))); await flush();
    expect(counts()).toEqual([2, 1, 0, 64]); expect(buttons()).toHaveLength(80);
  });
  it('exposes overflow buttons and keyboard scrolling, and reveals a focused offscreen desk', async () => {
    platform.current = state([agent(0), agent(1), agent(2)]); platform.current.window.mode = 'taskbar'; await start();
    const workspace = root.querySelector<HTMLElement>('.workspace')!;
    Object.defineProperties(workspace, { clientWidth: { configurable: true, value: 200 }, scrollWidth: { configurable: true, value: 360 } });
    let scroll = 0; Object.defineProperty(workspace, 'scrollLeft', { configurable: true, get: () => scroll, set: value => { scroll = Math.max(0, Math.min(160, value)); } });
    interact(() => workspace.dispatchEvent(new Event('scroll')));
    const left = root.querySelector<HTMLButtonElement>('[aria-label="Scroll desks left"]')!, right = root.querySelector<HTMLButtonElement>('[aria-label="Scroll desks right"]')!;
    expect(left.disabled).toBe(true); expect(right.disabled).toBe(false); click(right); expect(scroll).toBe(120); expect(left.disabled).toBe(false);
    key(workspace, 'End'); expect(scroll).toBe(160); expect(right.disabled).toBe(true);
    key(workspace, 'Home'); expect(scroll).toBe(0); key(workspace, 'ArrowRight'); expect(scroll).toBe(120); click(left); expect(scroll).toBe(0);
    vi.spyOn(workspace, 'getBoundingClientRect').mockReturnValue({ left: 88, right: 288 } as DOMRect);
    vi.spyOn(buttons()[2], 'getBoundingClientRect').mockReturnValue({ left: 328, right: 440 } as DOMRect);
    interact(() => buttons()[2].focus()); expect(scroll).toBe(152); expect(document.activeElement).toBe(buttons()[2]);
    key(buttons()[2], 'ArrowLeft'); expect(scroll).toBe(152);
  });
  it.each(['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'mode', 'pass-through', 'fullscreen', 'unmount'])('cleans a pending native drag after %s without a zombie begin', async reason => {
    platform.current.window.mode = 'taskbar'; await start();
    const grip = root.querySelector<HTMLButtonElement>('.strip-drag')!;
    grip.setPointerCapture = vi.fn(); grip.hasPointerCapture = vi.fn(() => false); grip.releasePointerCapture = vi.fn();
    const pointer = (type: string) => { const event = new MouseEvent(type, { bubbles: true, button: 0 }); Object.defineProperty(event, 'pointerId', { value: 7 }); interact(() => grip.dispatchEvent(event)); };
    const original = platform.command.bind(platform); let resolve!: (value?: unknown) => void;
    vi.spyOn(platform, 'command').mockImplementation(command => command.name === 'begin_taskbar_drag' ? new Promise(done => { platform.commands.push(command); resolve = done; }) : original(command));
    pointer('pointerdown'); pointer('pointermove');
    expect(platform.commands.at(-1)).toEqual({ name: 'begin_taskbar_drag' });
    if (reason === 'blur') interact(() => window.dispatchEvent(new Event('blur')));
    else if (reason === 'mode') nativeUpdate({ mode: 'office' });
    else if (reason === 'pass-through') nativeUpdate({ clickThrough: true });
    else if (reason === 'fullscreen') nativeUpdate({ fullscreenHidden: true });
    else if (reason === 'unmount') interact(() => { app!.dispose(); app = undefined; });
    else pointer(reason);
    await act(async () => { resolve(); }); await flush();
    expect(platform.commands.filter(command => command.name === 'end_taskbar_drag')).toHaveLength(1);
    interact(() => vi.advanceTimersByTime(100));
    expect(platform.commands.filter(command => command.name === 'update_taskbar_drag')).toHaveLength(reason === 'pointerup' ? 1 : 0);
    expect(root.querySelector('.strip-drag')?.getAttribute('data-dragging')).not.toBe('true');
  });
  it('keeps long Unicode hover names intact, with full keyboard accessible details and untouched Office canvas offsets', async () => {
    const name = '研究🚀équipe agent '.repeat(40); platform.current = state([agent(0, { name })]); platform.current.window.mode = 'taskbar'; await start();
    const button = buttons()[0]; interact(() => button.focus());
    expect(button.querySelector('.strip-agent-name')?.textContent).toBe(name); expect(button.getAttribute('aria-label')).toContain(name);
    expect(button.querySelector('canvas')?.style.getPropertyValue('--sprite-bottom-gutter')).toMatch(/^[23]px$/);
    click(button); await flush(); expect(root.querySelector('#detail-title')?.textContent).toBe(name);
    expect(root.querySelector('canvas')?.style.getPropertyValue('--sprite-bottom-gutter')).toBe('');
  });

  it('keeps keyboard placement focus during pending IPC and blocks repeated key commands', async () => {
    platform.current.window.mode = 'taskbar'; await start(); const grip = root.querySelector<HTMLButtonElement>('.strip-drag')!;
    let resolve!: (value: unknown) => void; const original = platform.command.bind(platform);
    vi.spyOn(platform, 'command').mockImplementation(command => command.name === 'set_taskbar_position' ? new Promise(done => { platform.commands.push(command); resolve = done; }) : original(command));
    interact(() => grip.focus()); key(grip, 'ArrowRight'); key(grip, 'ArrowRight');
    expect(grip.disabled).toBe(false); expect(grip.getAttribute('aria-disabled')).toBe('true'); expect(document.activeElement).toBe(grip);
    expect(platform.commands.filter(command => command.name === 'set_taskbar_position')).toHaveLength(1);
    await act(async () => resolve({ ...platform.current, sequence: platform.current.sequence + 1, window: { ...platform.current.window, taskbarPlacement: { alignment: 'free', position: 0.51 } } })); await flush();
    expect(grip.getAttribute('aria-disabled')).toBeNull(); expect(document.activeElement).toBe(grip);
  });
  it('retries a transient content-width error on the next authoritative update without a retry loop', async () => {
    platform.current.window.mode = 'taskbar'; platform.failure = new Error('Transient resize failure'); await start();
    expect(root.querySelector('.strip-notice')?.textContent).toContain('Transient resize failure');
    const counts = () => platform.commands.filter(command => command.name === 'set_taskbar_content_count');
    expect(counts()).toHaveLength(1); interact(() => vi.advanceTimersByTime(2000)); await flush(); expect(counts()).toHaveLength(1);
    platform.failure = undefined; nativeUpdate({}); await flush(); expect(counts()).toHaveLength(2); expect(counts()[1]).toEqual({ name: 'set_taskbar_content_count', args: { count: 1 } });
    nativeUpdate({}); await flush(); expect(counts()).toHaveLength(2);
    expect(root.querySelector('.strip-notice')).toBeNull();
  });

});
