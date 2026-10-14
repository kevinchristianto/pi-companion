import type { AgentState } from './model';
import moss from './assets/pixel-office/characters/moss-curls.png?url';
import mossHands from './assets/pixel-office/characters/moss-curls-hands.png?url';
import amber from './assets/pixel-office/characters/amber-braid.png?url';
import amberHands from './assets/pixel-office/characters/amber-braid-hands.png?url';
import plum from './assets/pixel-office/characters/plum-bun.png?url';
import plumHands from './assets/pixel-office/characters/plum-bun-hands.png?url';
import sky from './assets/pixel-office/characters/sky-part.png?url';
import skyHands from './assets/pixel-office/characters/sky-part-hands.png?url';
import coral from './assets/pixel-office/characters/coral-coils.png?url';
import coralHands from './assets/pixel-office/characters/coral-coils-hands.png?url';
import sage from './assets/pixel-office/characters/sage-bob.png?url';
import sageHands from './assets/pixel-office/characters/sage-bob-hands.png?url';
import chair from './assets/pixel-office/shared/chair.png?url';
import desk from './assets/pixel-office/shared/desk.png?url';
import laptop from './assets/pixel-office/shared/laptop.png?url';

export const DESIGN_IDS = ['moss-curls', 'amber-braid', 'plum-bun', 'sky-part', 'coral-coils', 'sage-bob'] as const;
export type DesignId = typeof DESIGN_IDS[number];
export const CELL = 64;
export const COLUMNS = 8;
export const ROWS = 4;
export const ILLUSTRATED_LIMIT = 64;
export const ASSET_URLS = {
  'characters/moss-curls.png': moss, 'characters/moss-curls-hands.png': mossHands,
  'characters/amber-braid.png': amber, 'characters/amber-braid-hands.png': amberHands,
  'characters/plum-bun.png': plum, 'characters/plum-bun-hands.png': plumHands,
  'characters/sky-part.png': sky, 'characters/sky-part-hands.png': skyHands,
  'characters/coral-coils.png': coral, 'characters/coral-coils-hands.png': coralHands,
  'characters/sage-bob.png': sage, 'characters/sage-bob-hands.png': sageHands,
  'shared/chair.png': chair, 'shared/desk.png': desk, 'shared/laptop.png': laptop,
} as const;
export type AssetKey = keyof typeof ASSET_URLS;
export type SpriteAssets = Record<AssetKey, HTMLImageElement>;

/** Pure, stable across reorders and refreshes. The identity is never used as an artwork URL. */
export function designForIdentity(identity: string): DesignId {
  let hash = 2166136261;
  for (const char of identity) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return DESIGN_IDS[(hash >>> 0) % DESIGN_IDS.length];
}
export function animationForState(state: AgentState): { row: number; fps: 0 | 4 | 8 } {
  switch (state) {
    case 'idle': return { row: 0, fps: 4 };
    case 'working': return { row: 1, fps: 8 };
    case 'thinking': return { row: 2, fps: 4 };
    case 'waiting': case 'error': return { row: 3, fps: 4 };
    default: return { row: 0, fps: 0 };
  }
}
export function frameAt(state: AgentState, elapsed: number, reducedMotion = false): { row: number; column: number } {
  const { row, fps } = animationForState(state);
  return { row, column: reducedMotion || !fps ? 0 : Math.floor(Math.max(0, elapsed) * fps / 1000) % COLUMNS };
}
export function validDimensions(key: AssetKey, width: number, height: number): boolean {
  return key.startsWith('shared/') ? width === CELL && height === CELL : width === CELL * COLUMNS && height === CELL * ROWS;
}
let loaded: Promise<SpriteAssets> | undefined;
export function loadSpriteAssets(): Promise<SpriteAssets> {
  // The complete exact compile-time allowlist is loaded once, never re-fetched for snapshots.
  return loaded ??= Promise.all(Object.entries(ASSET_URLS).map(([key, url]) => new Promise<[AssetKey, HTMLImageElement]>((resolve, reject) => {
    const image = new Image();
    image.onload = () => validDimensions(key as AssetKey, image.naturalWidth, image.naturalHeight)
      ? resolve([key as AssetKey, image]) : reject(new Error(`Invalid dimensions for bundled artwork: ${key}`));
    image.onerror = () => reject(new Error(`Could not load bundled artwork: ${key}`));
    image.src = url;
  }))).then(entries => Object.fromEntries(entries) as SpriteAssets);
}

/** Every layer is registered to the same source cell; destinations use whole CSS pixels. */
export function drawSprite(canvas: HTMLCanvasElement, assets: SpriteAssets, identity: string, state: AgentState, elapsed: number, scale: 1 | 2, reducedMotion: boolean): void {
  const size = CELL * scale;
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const design = designForIdentity(identity);
  const { row, column } = frameAt(state, elapsed, reducedMotion);
  const prop = (name: 'chair' | 'desk' | 'laptop') => ctx.drawImage(assets[`shared/${name}.png`], 0, 0, CELL, CELL, 0, 0, size, size);
  const layer = (suffix: '' | '-hands') => ctx.drawImage(assets[`characters/${design}${suffix}.png`], column * CELL, row * CELL, CELL, CELL, 0, 0, size, size);
  prop('chair'); layer(''); prop('desk'); prop('laptop'); layer('-hands');
}
