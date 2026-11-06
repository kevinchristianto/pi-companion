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
/** Audited composite alpha baseline, all 4 rows × 8 frames. Raw PNGs stay intact. */
export const SPRITE_BOTTOM_GUTTER: Record<DesignId, 2 | 3> = { 'moss-curls': 3, 'amber-braid': 3, 'plum-bun': 2, 'sky-part': 2, 'coral-coils': 2, 'sage-bob': 2 };
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

/** Stable preferred design; roster allocation resolves collisions. Never an artwork URL. */
export function designForIdentity(identity: string): DesignId {
  let hash = 2166136261;
  for (const char of identity) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return DESIGN_IDS[(hash >>> 0) % DESIGN_IDS.length];
}
/**
 * Use every design before repeating one, and spread unavoidable repeats evenly.
 * Keep existing assignments where possible. Sorting makes snapshot order irrelevant;
 * the previous map may include hidden agents, but only visible identities reserve art.
 */
export function assignDesigns(identities: readonly string[], previous: ReadonlyMap<string, DesignId> = new Map()): Map<string, DesignId> {
  const keys = [...new Set(identities)].sort();
  const assigned = new Map<string, DesignId>();
  const counts = new Map<DesignId, number>(DESIGN_IDS.map(design => [design, 0]));
  const previousCounts = new Map(counts); const preferredCounts = new Map(counts);
  for (const key of keys) {
    const old = previous.get(key); if (old) previousCounts.set(old, previousCounts.get(old)! + 1);
    const preferred = designForIdentity(key); preferredCounts.set(preferred, preferredCounts.get(preferred)! + 1);
  }
  // Balanced capacities keep every assignment in an already balanced roster,
  // even when its repeated designs occur far apart in the snapshot.
  const extra = [...DESIGN_IDS].sort((a, b) => previousCounts.get(b)! - previousCounts.get(a)! || preferredCounts.get(b)! - preferredCounts.get(a)!)
    .slice(0, keys.length % DESIGN_IDS.length);
  const capacity = new Map(DESIGN_IDS.map(design => [design, Math.floor(keys.length / DESIGN_IDS.length) + Number(extra.includes(design))]));
  const assign = (key: string, design: DesignId) => { assigned.set(key, design); counts.set(design, counts.get(design)! + 1); };
  // Reserve existing residents before placing new arrivals.
  for (const key of keys) {
    const design = previous.get(key);
    if (design && counts.get(design)! < capacity.get(design)!) assign(key, design);
  }
  const remaining = keys.filter(key => !assigned.has(key));
  for (const key of [...remaining.filter(key => previous.has(key)), ...remaining.filter(key => !previous.has(key))]) {
    const preferred = previous.get(key) ?? designForIdentity(key);
    const start = DESIGN_IDS.indexOf(preferred);
    const leastUsed = Math.min(...DESIGN_IDS.filter(design => counts.get(design)! < capacity.get(design)!).map(design => counts.get(design)!));
    const design = Array.from({ length: DESIGN_IDS.length }, (_, offset) => DESIGN_IDS[(start + offset) % DESIGN_IDS.length])
      .find(design => counts.get(design) === leastUsed && counts.get(design)! < capacity.get(design)!)!;
    assign(key, design);
  }
  return assigned;
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
export function drawSprite(canvas: HTMLCanvasElement, assets: SpriteAssets, design: DesignId, state: AgentState, elapsed: number, scale: 1 | 2, reducedMotion: boolean): void {
  const size = CELL * scale;
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  const { row, column } = frameAt(state, elapsed, reducedMotion);
  const prop = (name: 'chair' | 'desk' | 'laptop') => ctx.drawImage(assets[`shared/${name}.png`], 0, 0, CELL, CELL, 0, 0, size, size);
  const layer = (suffix: '' | '-hands') => ctx.drawImage(assets[`characters/${design}${suffix}.png`], column * CELL, row * CELL, CELL, CELL, 0, 0, size, size);
  prop('chair'); layer(''); prop('desk'); prop('laptop'); layer('-hands');
}
