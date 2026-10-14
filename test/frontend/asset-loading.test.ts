import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe('required runtime atlas loading', () => {
  it('loads only the fixed imported artwork once and validates natural dimensions', async () => {
    const assigned: string[] = [];
    class ImageStub {
      naturalWidth = 512; naturalHeight = 256; onload?: () => void;
      set src(value: string) { assigned.push(value); if (/\/(chair|desk|laptop)\.png/.test(value)) { this.naturalWidth = 64; this.naturalHeight = 64; } queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', ImageStub); const module = await import('../../src/sprites');
    const first = module.loadSpriteAssets(); expect(module.loadSpriteAssets()).toBe(first);
    const assets = await first; expect(Object.keys(assets)).toHaveLength(15);
    expect(assigned.sort()).toEqual(Object.values(module.ASSET_URLS).sort());
  });
  it('fails the full composition when a configured foreground has the wrong size', async () => {
    class BadImage {
      naturalWidth = 512; naturalHeight = 256; onload?: () => void;
      set src(value: string) { if (/\/shared\//.test(value)) { this.naturalWidth = 64; this.naturalHeight = 64; } if (value.includes('moss-curls-hands')) this.naturalWidth = 511; queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', BadImage); const { loadSpriteAssets } = await import('../../src/sprites');
    await expect(loadSpriteAssets()).rejects.toThrow('Invalid dimensions');
  });
  it('fails rather than silently dropping a missing hand layer', async () => {
    class MissingImage {
      naturalWidth = 512; naturalHeight = 256; onload?: () => void; onerror?: () => void;
      set src(value: string) { if (/\/shared\//.test(value)) { this.naturalWidth = 64; this.naturalHeight = 64; } queueMicrotask(() => value.includes('sage-bob-hands') ? this.onerror?.() : this.onload?.()); }
    }
    vi.stubGlobal('Image', MissingImage); const { loadSpriteAssets } = await import('../../src/sprites');
    await expect(loadSpriteAssets()).rejects.toThrow('Could not load bundled artwork');
  });
});
