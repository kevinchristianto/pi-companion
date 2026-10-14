/** Two-way fixture protocol: Rust owns real bridge starts/restarts; Pi uses its normal entry. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { installedFixture, fixtureToken, rotatedFixtureToken } from './installed-fixture.mjs';
import { parseConnection } from '../connection.ts';

assert.equal(process.env.PI_COMPANION_CONNECTION_FILE, undefined);
const deadline = setTimeout(() => {
  process.stderr.write('Automatic discovery roundtrip exceeded its 25-second test deadline.\n');
  process.exit(1);
}, 25_000);
deadline.unref();
const input = createInterface({ input: process.stdin });
const lines = input[Symbol.asyncIterator]();
async function command(name, expectedToken) {
  process.stdout.write(name + '\n');
  const next = await lines.next();
  assert.equal(next.done, false, 'Rust fixture ended its control pipe early');
  const connection = parseConnection(JSON.parse(next.value));
  assert.equal(connection.token, expectedToken, 'Only the fixed public fixture credentials may be used');
  return connection;
}
async function snapshot(connection) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${connection.url}/api/snapshot`, { agent: false, headers: { authorization: `Bearer ${connection.token}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => {
        try { assert.equal(response.statusCode, 200); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Fixture snapshot deadline')));
  });
}
async function connected(connection, expectedName) {
  const until = performance.now() + 7000;
  while (performance.now() < until) {
    const value = await snapshot(connection);
    if (value.agents.length === 1 && value.agents[0].name === expectedName) return;
    await sleep(30);
  }
  assert.fail('Normal Pi extension did not automatically discover the current Rust bridge');
}
const installed = await installedFixture();
const handlers = new Map();
const context = { cwd: '/unrelated/fixture/project', sessionManager: { getSessionId: () => 'rust-discovery-session' }, isIdle: () => true };
const emit = (event, data = {}) => handlers.get(event)?.(data, context);
let sessionName = 'Pi started before app';
try {
  const { default: piCompanion } = await installed.load();
  piCompanion({ on(name, handler) { handlers.set(name, handler); }, getSessionName: () => sessionName });
  await emit('session_start');
  // The normal first attempt must fail on the missing file before Rust starts the app.
  await sleep(200);
  const original = await command('start', fixtureToken);
  await installed.connect(original.url, original.token);
  await connected(original, 'Pi started before app');
  const restarted = await command('restart', rotatedFixtureToken);
  await installed.connect(restarted.url, restarted.token);
  sessionName = 'Pi survived real app restart';
  await emit('session_info_changed', { name: sessionName });
  await connected(restarted, sessionName);
  await emit('session_shutdown');
  assert.equal((await snapshot(restarted)).agents.length, 0);
  process.stdout.write('done\n');
} finally {
  await emit('session_shutdown');
  await installed.remove(); input.close(); clearTimeout(deadline);
}
