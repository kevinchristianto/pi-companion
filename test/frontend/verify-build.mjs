import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sources = JSON.parse(readFileSync('src/assets/pixel-office/ASSET-SOURCES.json', 'utf8'));
const files = readdirSync('dist/assets');
const scripts = files.filter(name => name.endsWith('.js')).map(name => readFileSync(join('dist/assets', name), 'utf8')).join('\n');
for (const fixture of ['explicit-dev-review', 'review-workshop', 'review-studio', 'Building the next thoughtful little thing.']) assert(!scripts.includes(fixture), `Production contains review fixture: ${fixture}`);
assert(!files.some(name => name.endsWith('.map')), 'Production includes an unexpected source map');
const emitted = files.filter(name => name.endsWith('.png')).map(name => createHash('sha256').update(readFileSync(join('dist/assets', name))).digest('hex')).sort();
assert.deepEqual(emitted, sources.files.map(file => file.sha256).sort(), 'Production art must be exactly the 15 byte-identical local inputs');
console.log(`Production verified: ${emitted.length} unchanged PNGs; no review data or source maps.`);
