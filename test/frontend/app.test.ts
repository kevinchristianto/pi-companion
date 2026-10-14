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
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const byText = (text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;
const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.agent-button')];
const start = async () => { app = createApp(root, platform, Promise.resolve(assets)); await app.ready; await flush(); };

beforeEach(() => {
  vi.useFakeTimers(); document.body.replaceChildren(); root = document.createElement('div'); document.body.append(root);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  reduced = false; mediaListener = undefined;
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced; }, addEventListener: (_: string, callback: () => void) => { mediaListener = callback; }, removeEventListener: vi.fn() }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn(), clearRect: vi.fn(), imageSmoothingEnabled: true } as unknown as CanvasRenderingContext2D);
  platform = new TestPlatform();
});
afterEach(() => { app?.dispose(); app = undefined; vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    buttons()[0].click(); expect(root.querySelector('img,script')).toBeNull();
    expect(root.querySelector('.detail-task')?.textContent).toBe('<script>bad()</script>');
  });
  it('keeps connected idle agents without a frontend liveness/activity timer', async () => {
    await start(); const reads = platform.reads;
    vi.advanceTimersByTime(60000); expect(buttons()).toHaveLength(1); expect(platform.reads).toBe(reads);
    platform.emit(state([], 2)); expect(buttons()).toHaveLength(0);
  });
  it('keeps existing nodes and keyboard focus across ordinary snapshots', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const first = buttons()[0]; first.focus();
    platform.emit(state([agent(0, { state: 'working' }), agent(1)], 2));
    expect(buttons()[0]).toBe(first); expect(document.activeElement).toBe(first);
  });
  it('keeps keyboard focus when a snapshot reorders the focused resident', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const second = buttons()[1]; second.focus();
    platform.emit(state([agent(1), agent(0)], 2));
    expect(buttons()[0]).toBe(second); expect(document.activeElement).toBe(second);
  });
  it('subscribes before the initial read and ignores a late older response', async () => {
    let resolveRead!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    app = createApp(root, platform, Promise.resolve(assets)); await flush();
    platform.emit(state([agent(2)], 3));
    resolveRead(state([agent(1)], 2)); await app.ready;
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 2');
  });
  it('keeps a newer authoritative event when the initial read fails late', async () => {
    let rejectRead!: (reason: unknown) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
    app = createApp(root, platform, Promise.resolve(assets)); await flush();
    platform.emit(state([agent(2)], 3));
    rejectRead(new Error('Old read failed')); await app.ready;
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 2');
  });
  it('handles selection, close, Escape, and selected-agent removal without trapped focus', async () => {
    platform.current = state([agent(0), agent(1)]); await start();
    const first = buttons()[0]; first.click(); expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement?.id).toBe('detail-title');
    byText('Close details').click(); expect(document.activeElement).toBe(first);
    first.click(); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.activeElement).toBe(first); expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(true);
    first.click(); platform.emit(state([agent(1)], 2)); expect(document.activeElement).toBe(buttons()[0]);
    expect(root.querySelector('.detail')?.hasAttribute('hidden')).toBe(true);
  });
  it('hides all agents on malformed/disconnected data and rejects stale revival', async () => {
    await start(); platform.emit({ wrong: true }); expect(buttons()).toHaveLength(0);
    platform.emit(state()); expect(buttons()).toHaveLength(0);
    platform.emit(state([agent()], 2)); expect(buttons()).toHaveLength(1);
    const disconnected = state([agent()], 3); disconnected.bridge.status = 'error'; platform.emit(disconnected);
    expect(buttons()).toHaveLength(0); expect(root.textContent).toContain('No agents are shown');
  });
  it('caps illustrated agents at 64 while retaining the entire accessible roster and list', async () => {
    platform.current = state(Array.from({ length: 80 }, (_, i) => agent(i))); await start();
    expect(buttons()).toHaveLength(80); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(64);
    expect(root.querySelector('.capacity')?.textContent).toContain('remaining 16');
    byText('List').click(); expect(buttons()).toHaveLength(80); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0); byText('Office').click(); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(64);
  });
  it('discloses authoritative backend overflow even in text-list view', async () => {
    platform.current.snapshot.omittedAgentCount = 9; await start(); byText('List').click();
    expect(root.querySelector('.capacity')?.hasAttribute('hidden')).toBe(false); expect(root.querySelector('.capacity')?.textContent).toContain('omitted 9 additional agents');
  });
  it('filters sessions and resets cleanly when the selected session closes', async () => {
    platform.current = state([agent(0), agent(1, { sessionId: 'other', sessionName: 'Another room' })]); await start();
    const select = root.querySelector<HTMLSelectElement>('[aria-label="Filter by session"]')!; select.value = 'other'; select.dispatchEvent(new Event('change'));
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Another room');
    platform.emit(state([agent(0)], 2)); expect(select.value).toBe(''); expect(buttons()).toHaveLength(1);
  });
  it('shows useful text-only rows if any required artwork fails to load', async () => {
    app = createApp(root, platform, Promise.reject(new Error('Missing foreground'))); await app.ready; await flush();
    expect(buttons()).toHaveLength(1); expect(root.querySelectorAll('canvas:not([hidden])')).toHaveLength(0);
    expect(root.querySelector('.art-warning')?.hasAttribute('hidden')).toBe(false);
  });
});

describe('animation and native controls', () => {
  it('uses one animation timer and pauses for hidden pages, reduced motion, and explicit pause', async () => {
    await start(); expect(vi.getTimerCount()).toBe(1);
    byText('Pause motion').click(); expect(vi.getTimerCount()).toBe(0);
    byText('Resume motion').click(); expect(vi.getTimerCount()).toBe(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    platform.current = state([agent()], 2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); await flush();
    expect(vi.getTimerCount()).toBe(1);
    reduced = true; mediaListener?.(); expect(vi.getTimerCount()).toBe(0); expect(byText('Reduced motion').disabled).toBe(true);
  });
  it('keeps restoration fail-closed until a fresh authoritative snapshot arrives', async () => {
    await start();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange'));
    let resolveRead!: (value: ReturnType<typeof state>) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise(resolve => { resolveRead = resolve; }));
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange'));
    expect(buttons()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    expect(root.textContent).toContain('Refreshing the live connection');
    resolveRead(state([agent(3)], 2)); await flush();
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 3'); expect(vi.getTimerCount()).toBe(1);
  });
  it('does not erase a newer live event when an older restore read rejects', async () => {
    await start();
    let rejectRead!: (reason: unknown) => void;
    vi.spyOn(platform, 'getState').mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(buttons()).toHaveLength(0);
    platform.emit(state([agent(4)], 2)); rejectRead(new Error('Older restore failed')); await flush();
    expect(buttons()).toHaveLength(1); expect(buttons()[0].textContent).toContain('Agent 4'); expect(vi.getTimerCount()).toBe(1);
  });
  it('uses one intersection observer and stops when every illustrated tile is offscreen', async () => {
    let callback: IntersectionObserverCallback | undefined; const observe = vi.fn(); const disconnect = vi.fn();
    vi.stubGlobal('IntersectionObserver', class { constructor(fn: IntersectionObserverCallback) { callback = fn; } observe = observe; unobserve = vi.fn(); disconnect = disconnect; });
    await start(); expect(observe).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
    const entry = { target: root.querySelector('.agent')!, isIntersecting: true } as IntersectionObserverEntry;
    callback!([entry], {} as IntersectionObserver); expect(vi.getTimerCount()).toBe(1);
    callback!([{ ...entry, isIntersecting: false }], {} as IntersectionObserver); expect(vi.getTimerCount()).toBe(0);
    app!.dispose(); app = undefined;
    expect(disconnect).toHaveBeenCalledOnce();
    callback!([entry], {} as IntersectionObserver); expect(vi.getTimerCount()).toBe(0);
  });
  it('updates 1x/2x backing-store sizes without fractional fitting', async () => {
    await start(); const select = root.querySelector<HTMLSelectElement>('[aria-label="Artwork scale"]')!;
    expect(root.querySelector('canvas')?.width).toBe(128);
    select.value = '1'; select.dispatchEvent(new Event('change')); expect(root.querySelector('canvas')?.width).toBe(64);
    select.value = '2'; select.dispatchEvent(new Event('change')); expect(root.querySelector('canvas')?.width).toBe(128);
  });
  it('uses only named commands and reflects authoritative pin state', async () => {
    await start(); byText('Pin').click(); await flush();
    expect(platform.commands).toEqual([{ name: 'set_pinned', args: { pinned: true } }]);
    expect(byText('Pinned').getAttribute('aria-pressed')).toBe('true');
    byText('Hide').click(); await flush(); expect(platform.commands.at(-1)).toEqual({ name: 'hide_window' });
  });
  it('keeps truthful state and useful feedback when a window command fails', async () => {
    await start(); platform.failure = new Error('Native pin failed'); byText('Pin').click(); await flush();
    expect(byText('Pin').getAttribute('aria-pressed')).toBe('false'); expect(root.querySelector('.command-feedback')?.textContent).toBe('Native pin failed');
  });
  it('disables hide and pass-through unless native recovery is available', async () => {
    platform.current.window.recoveryAvailable = false; await start();
    expect(byText('Hide').disabled).toBe(true); expect(byText('Pass through').disabled).toBe(true);
    byText('Hide').click(); byText('Pass through').click(); expect(platform.commands).toEqual([]);
  });
  it('removes subscriptions, document listeners, and all scheduled work on disposal', async () => {
    await start(); app!.dispose(); app = undefined;
    expect(platform.unsubscribed).toBe(true); expect(vi.getTimerCount()).toBe(0); expect(root.childElementCount).toBe(0);
    const reads = platform.reads; document.dispatchEvent(new Event('visibilitychange')); expect(platform.reads).toBe(reads);
    platform.emit(state([agent(9)], 4)); expect(root.childElementCount).toBe(0);
  });
  it('cleans up a subscription that finishes after disposal without requesting state', async () => {
    let resolveSubscribe!: (unsubscribe: () => void) => void; const unsubscribe = vi.fn();
    vi.spyOn(platform, 'subscribe').mockImplementation(() => new Promise(resolve => { resolveSubscribe = resolve; }));
    app = createApp(root, platform, Promise.resolve(assets)); app.dispose();
    resolveSubscribe(unsubscribe); await app.ready; app = undefined;
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(platform.reads).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('one-time Pi connection setup', () => {
  it('provides a selectable JSON settings entry without per-session setup or credential data', async () => {
    const path = 'C:\\Users\\Zoë Work\\AppData\\Roaming\\Pi Companion\\observer\\index.ts';
    platform.current.bridge.observerEntry = path;
    await start(); byText('Connection guide').click();
    const entry = root.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(JSON.parse(entry.value)).toEqual({ extensions: [path] });
    expect(entry.readOnly).toBe(true);
    expect(root.querySelector('.guide')?.textContent).toContain('existing extensions array');
    expect(root.querySelector('.guide')?.textContent).toContain('/reload');
    expect(root.querySelector('.guide')?.textContent).not.toContain('PI_COMPANION_CONNECTION_FILE');
    expect(root.querySelector('.guide')?.textContent).not.toContain('--extension');
    expect(root.querySelector('.guide')?.textContent).not.toContain('/local/config/connection.json');
    byText('Select config entry').click();
    expect(document.activeElement).toBe(entry);
    expect(entry.selectionStart).toBe(0); expect(entry.selectionEnd).toBe(entry.value.length);
    expect(platform.commands).toEqual([]);
  });
  it('does not invent an observer path before a verified native export is available', async () => {
    await start();
    const entry = root.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(entry.value).toBe(''); expect(byText('Select config entry').disabled).toBe(true);
    const available = state([], 2); available.bridge.observerEntry = '/relocated/私の profile/observer/index.ts';
    platform.emit(available);
    expect(JSON.parse(entry.value)).toEqual({ extensions: ['/relocated/私の profile/observer/index.ts'] });
    expect(byText('Select config entry').disabled).toBe(false);
    platform.emit(state([], 3));
    expect(entry.value).toBe(''); expect(byText('Select config entry').disabled).toBe(true);
  });
  it('encodes quoted path characters as JSON and never treats them as HTML', async () => {
    const path = '/private/<img src=x>/a"quoted/observer/index.ts';
    platform.current.bridge.observerEntry = path;
    await start();
    const entry = root.querySelector<HTMLTextAreaElement>('[aria-label="Pi settings entry"]')!;
    expect(JSON.parse(entry.value).extensions).toEqual([path]);
    expect(root.querySelector('img, script')).toBeNull();
  });
});
