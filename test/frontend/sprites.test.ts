import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_URLS, animationForState, assignDesigns, DESIGN_IDS, designForIdentity, drawSprite, frameAt, validDimensions } from '../../src/sprites';
import type { SpriteAssets } from '../../src/sprites';
import provenance from '../../src/assets/pixel-office/ASSET-SOURCES.json';

describe('exact bundled sprite contract', () => {
  it('contains only six 512×256 character/hand pairs and three 64×64 props', () => {
    const root = join(process.cwd(), 'src/assets/pixel-office');
    const files = ['characters', 'shared'].flatMap(dir => readdirSync(join(root, dir)).map(file => `${dir}/${file}`));
    expect(files.sort()).toEqual(Object.keys(ASSET_URLS).sort()); expect(files).toHaveLength(15);
    for (const file of provenance.files) {
      const bytes = readFileSync(join(root, file.path));
      expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(validDimensions(file.path as keyof typeof ASSET_URLS, bytes.readUInt32BE(16), bytes.readUInt32BE(20))).toBe(true);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
  });
  it('keeps identity-to-design stable independent of roster ordering or state', () => {
    const identities = Array.from({ length: 100 }, (_, i) => `project/${i}`);
    const before = identities.map(designForIdentity);
    expect([...identities].reverse().map(designForIdentity).reverse()).toEqual(before);
    expect(new Set(before)).toEqual(new Set(DESIGN_IDS));
    expect(designForIdentity('https://remote.example/x.png')).toBeOneOf([...DESIGN_IDS]);
  });
  it('uses exactly eight slots with 4fps idle/thinking/attention and 8fps typing', () => {
    expect(animationForState('idle')).toEqual({ row: 0, fps: 4 });
    expect(animationForState('working')).toEqual({ row: 1, fps: 8 });
    expect(animationForState('thinking')).toEqual({ row: 2, fps: 4 });
    expect(animationForState('waiting')).toEqual({ row: 3, fps: 4 });
    expect(animationForState('error')).toEqual({ row: 3, fps: 4 });
    for (let i = 0; i < 8; i++) {
      expect(frameAt('working', i * 125)).toEqual({ row: 1, column: i });
      expect(frameAt('thinking', i * 250)).toEqual({ row: 2, column: i });
    }
    expect(frameAt('working', 1000).column).toBe(0); expect(frameAt('idle', 2000).column).toBe(0);
  });
  it('reduced motion selects the first state frame, nonlive states use static idle', () => {
    expect(frameAt('working', 999, true)).toEqual({ row: 1, column: 0 });
    for (const state of ['completed', 'stale', 'offline', 'unknown'] as const) expect(frameAt(state, 999)).toEqual({ row: 0, column: 0 });
  });
  it.each([1, 2] as const)('composes whole-pixel 5-layer nearest-neighbor art at %sx', scale => {
    const canvas = document.createElement('canvas');
    const drawImage = vi.fn(); const context = { drawImage, clearRect: vi.fn(), imageSmoothingEnabled: true };
    vi.spyOn(canvas, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const images = Object.fromEntries(Object.keys(ASSET_URLS).map(key => [key, { key }])) as unknown as SpriteAssets;
    const design = designForIdentity('test');
    drawSprite(canvas, images, design, 'working', 250, scale, false);
    expect(drawImage.mock.calls.map(call => (call[0] as { key: string }).key)).toEqual(['shared/chair.png', `characters/${design}.png`, 'shared/desk.png', 'shared/laptop.png', `characters/${design}-hands.png`]);
    expect(drawImage.mock.calls[1].slice(1)).toEqual([128, 64, 64, 64, 0, 0, 64 * scale, 64 * scale]);
    expect(canvas.width).toBe(64 * scale); expect(canvas.height).toBe(64 * scale); expect(context.imageSmoothingEnabled).toBe(false);
  });
  it('rejects dimensions which would resample or truncate frames', () => {
    expect(validDimensions('characters/moss-curls.png', 511, 256)).toBe(false);
    expect(validDimensions('characters/moss-curls-hands.png', 512, 255)).toBe(false);
    expect(validDimensions('shared/desk.png', 128, 128)).toBe(false);
  });
});

describe('attention correction state routing', () => {
  it.each(DESIGN_IDS)('selects corrected row for needs-input/review across %s', design => {
    const identity = Array.from({ length: 500 }, (_, i) => `attention/${i}`).find(id => designForIdentity(id) === design)!;
    expect(identity).toBeTruthy();
    const canvas = document.createElement('canvas'); const drawImage = vi.fn();
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage, clearRect: vi.fn(), imageSmoothingEnabled: true } as unknown as CanvasRenderingContext2D);
    const assets = Object.fromEntries(Object.keys(ASSET_URLS).map(key => [key, { key }])) as unknown as SpriteAssets;
    for (const state of ['waiting', 'error'] as const) for (const reduced of [false, true]) {
      for (let i = 0; i < 8; i++) {
        drawImage.mockClear(); drawSprite(canvas, assets, design, state, i * 250, 2, reduced);
        expect((drawImage.mock.calls[1][0] as { key: string }).key).toBe(`characters/${design}.png`);
        expect(drawImage.mock.calls[1].slice(1, 5)).toEqual([reduced ? 0 : i * 64, 192, 64, 64]);
        expect(drawImage.mock.calls[4].slice(1, 5)).toEqual([reduced ? 0 : i * 64, 192, 64, 64]);
      }
    }
  });
});

describe('roster-aware design allocation', () => {
  const colliding = Array.from({ length: 1000 }, (_, i) => `collision/${i}`).filter(key => designForIdentity(key) === DESIGN_IDS[0]);
  const balanced = (designs: ReturnType<typeof assignDesigns>) => {
    const counts = DESIGN_IDS.map(design => [...designs.values()].filter(value => value === design).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  };
  it('uses six distinct designs even when every identity hashes to the same preference', () => {
    for (let count = 1; count <= 6; count++) {
      const designs = assignDesigns(colliding.slice(0, count));
      expect(designs.size).toBe(count); expect(new Set(designs.values()).size).toBe(count);
    }
  });
  it('is deterministic across reorders and preserves existing residents when new agents join', () => {
    const initial = assignDesigns(colliding.slice(0, 3));
    const next = assignDesigns(colliding.slice(0, 6), initial);
    expect(assignDesigns(colliding.slice(0, 6).reverse(), initial)).toEqual(next);
    for (const [key, design] of initial) expect(next.get(key)).toBe(design);
    expect(assignDesigns(colliding.slice(0, 6), next)).toEqual(next);
    expect(assignDesigns(colliding.slice(0, 6))).toEqual(assignDesigns(colliding.slice(0, 6).reverse()));
  });
  it('balances unavoidable repeats and repairs collisions when a roster shrinks or is filtered', () => {
    const original = assignDesigns(colliding.slice(0, 13)); balanced(original);
    const repeated = DESIGN_IDS.find(design => [...original.values()].filter(value => value === design).length > 1)!;
    const pair = [...original.keys()].filter(key => original.get(key) === repeated).slice(0, 2);
    const filtered = assignDesigns(pair, original);
    expect(new Set(filtered.values()).size).toBe(2);
    expect(original.get(pair[0])).toBe(original.get(pair[1]));
    for (let count = 64; count >= 0; count--) {
      const next = assignDesigns(colliding.slice(0, count), original); balanced(next);
      expect(next.size).toBe(count);
      expect(assignDesigns(colliding.slice(0, count), next)).toEqual(next);
    }
  });
  it('ignores hidden identities for occupancy and never uses identities as asset keys', () => {
    const cache = new Map(colliding.slice(0, 6).map(key => [key, DESIGN_IDS[0]]));
    const before = new Map(cache);
    const key = 'https://remote.example/untrusted.png';
    const assigned = assignDesigns([key, key], cache);
    expect(assigned.size).toBe(1); expect(assigned.get(key)).toBeOneOf([...DESIGN_IDS]); expect(cache).toEqual(before);
    expect(assignDesigns([], cache).size).toBe(0);
  });
});
