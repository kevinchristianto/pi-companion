import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ASSET_URLS, animationForState, DESIGN_IDS, designForIdentity, drawSprite, frameAt, validDimensions } from '../../src/sprites';
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
    drawSprite(canvas, images, 'test', 'working', 250, scale, false);
    const design = designForIdentity('test');
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
