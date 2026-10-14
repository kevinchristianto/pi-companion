import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { installedFixture, fixtureToken, rotatedFixtureToken } from './installed-fixture.mjs';

async function until(predicate, description, timeout = 7000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, description);
    await sleep(20);
  }
}
async function prepare(t) {
  const saved = process.env.PI_COMPANION_CONNECTION_FILE;
  delete process.env.PI_COMPANION_CONNECTION_FILE;
  const fixture = await installedFixture();
  t.after(async () => {
    if (saved === undefined) delete process.env.PI_COMPANION_CONNECTION_FILE;
    else process.env.PI_COMPANION_CONNECTION_FILE = saved;
    await fixture.remove();
  });
  return fixture;
}
async function bridge(t) {
  const state = { token: fixtureToken, stream: 'fixture-bridge-first', requests: [], ingests: [], closed: false };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    state.requests.push({ route: req.url, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${state.token}`) { res.writeHead(401); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (req.url === '/api/hello') { res.end(JSON.stringify({ streamId: state.stream, source: { generation: 1 } })); return; }
    assert.equal(req.url, '/api/ingest');
    if (body.streamId !== state.stream) { res.writeHead(409); res.end(); return; }
    state.ingests.push(body); res.writeHead(202); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = async () => {
    if (state.closed) return;
    state.closed = true;
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  };
  t.after(state.close);
  return state;
}
async function activate(t, fixture, options) {
  const module = await fixture.load(), handlers = new Map();
  const pi = { on(name, handler) { handlers.set(name, handler); }, getSessionName: () => 'Relocated fixture session' };
  // The ordinary entry point has no options, environment override, or injected loader/request.
  const adapter = options === undefined ? module.default(pi) : module.installObserver(pi, options);
  const context = { cwd: '/unrelated/pi/project', sessionManager: { getSessionId: () => 'relocated-session' }, isIdle: () => true };
  const emit = (name, event = {}) => handlers.get(name)?.(event, context);
  t.after(() => emit('session_shutdown'));
  await emit('session_start');
  return { adapter, emit };
}

test('ordinary Pi entry discovers its adjacent app config after relocation with spaces and Unicode', async t => {
  const fixture = await prepare(t), local = await bridge(t);
  assert.notEqual(path.dirname(process.cwd()), fixture.root);
  assert.match(fixture.root, /relocated 空间 café /);
  await fixture.connect(local.url);
  const { emit } = await activate(t, fixture);
  await until(() => local.ingests.length === 1, 'ordinary Pi startup did not find its adjacent connection file');
  assert.equal(local.ingests[0].session.name, 'Relocated fixture session');
  assert.equal(local.requests[0].authorization, `Bearer ${fixtureToken}`);
  await emit('session_shutdown');
  assert.equal(local.ingests.at(-1).session.connected, false);
});

test('Pi launched before the app retries missing adjacent config automatically when the app starts', async t => {
  const fixture = await prepare(t);
  await activate(t, fixture);
  // The first scheduled load fails before any app or connection file exists.
  await sleep(200);
  await assert.rejects(fs.stat(fixture.connectionFile), { code: 'ENOENT' });
  const local = await bridge(t);
  await fixture.connect(local.url);
  await until(() => local.ingests.length > 0, 'missing-file retry did not connect after app startup');
  assert.equal(local.ingests[0].session.connected, true);
});

test('restart reloads the adjacent file and rotates the token and stream without Pi restart', async t => {
  const fixture = await prepare(t), local = await bridge(t);
  await fixture.connect(local.url);
  const { emit } = await activate(t, fixture, { heartbeatMs: 30 });
  await until(() => local.ingests.length > 0, 'initial app did not connect');
  // A restarted app rejects the old token and requires a fresh handshake.
  local.token = rotatedFixtureToken; local.stream = 'fixture-bridge-restarted';
  await fixture.connect(local.url, rotatedFixtureToken);
  await emit('session_info_changed', { name: 'Still running after restart' });
  await until(() => local.ingests.some(row => row.streamId === local.stream), 'automatic reconnect did not reload rotated credentials');
  assert.ok(local.requests.some(row => row.route === '/api/hello' && row.authorization === `Bearer ${rotatedFixtureToken}`));
  assert.equal(local.ingests.at(-1).session.connected, true);
});

test('explicit absolute override takes precedence without altering the default install', async t => {
  const fixture = await prepare(t), defaultBridge = await bridge(t), overrideBridge = await bridge(t);
  await fixture.connect(defaultBridge.url);
  const override = path.join(fixture.root, 'advanced connection café.json');
  await fs.writeFile(override, JSON.stringify({ version: 1, url: overrideBridge.url, token: fixtureToken }), { mode: 0o600 });
  process.env.PI_COMPANION_CONNECTION_FILE = override;
  await activate(t, fixture);
  await until(() => overrideBridge.ingests.length > 0, 'explicit override was not used');
  assert.equal(defaultBridge.requests.length, 0);
});

test('invalid explicit overrides fail closed instead of using an otherwise valid adjacent file', async t => {
  const fixture = await prepare(t), local = await bridge(t);
  await fixture.connect(local.url);
  const { adapter } = await activate(t, fixture, {});
  // Nothing is flushed until the invalid override has been installed.
  for (const invalid of ['', 'relative.json', '//server/share/connection.json', fixture.connectionFile + '\n', 'x'.repeat(4097)]) {
    process.env.PI_COMPANION_CONNECTION_FILE = invalid;
    await adapter.flush();
    assert.equal(local.requests.length, 0);
  }
  delete process.env.PI_COMPANION_CONNECTION_FILE;
  await adapter.flush();
  assert.equal(local.ingests.length, 1);
});

test('default discovery preserves bounded private regular-file checks and rejects aliases', async t => {
  const fixture = await prepare(t), local = await bridge(t);
  const { adapter } = await activate(t, fixture, {});
  for (const contents of ['{malformed', 'x'.repeat(4097), JSON.stringify({ version: 1, url: 'http://localhost:4318', token: fixtureToken })]) {
    await fs.writeFile(fixture.connectionFile, contents, { mode: 0o600 });
    await adapter.flush(); assert.equal(local.requests.length, 0);
  }
  await fixture.connect(local.url);
  const target = path.join(fixture.root, 'fixture-secret.json');
  await fs.rename(fixture.connectionFile, target);
  await t.test('default discovery rejects a final-component symlink', async subtest => {
    try { await fs.symlink(target, fixture.connectionFile); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        subtest.skip('This Windows account cannot create file symlinks; junction rejection is still tested'); return;
      }
      throw error;
    }
    try { await adapter.flush(); assert.equal(local.requests.length, 0); }
    finally { await fs.unlink(fixture.connectionFile); }
  });
  await fs.link(target, fixture.connectionFile);
  await adapter.flush(); assert.equal(local.requests.length, 0);
  await fs.unlink(fixture.connectionFile); await fs.unlink(target);
  await fixture.connect(local.url);
  if (process.platform !== 'win32') {
    await fs.chmod(fixture.connectionFile, 0o644);
    await adapter.flush(); assert.equal(local.requests.length, 0);
    await fs.chmod(fixture.connectionFile, 0o600);
  }
  await adapter.flush(); assert.equal(local.ingests.length, 1);
});

test('explicit override rejects parent symlinks or Windows junctions before making a request', async t => {
  const fixture = await prepare(t), local = await bridge(t);
  await fixture.connect(local.url);
  const alias = path.join(fixture.root, 'parent alias');
  await fs.symlink(fixture.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.PI_COMPANION_CONNECTION_FILE = path.join(alias, 'connection.json');
  const { adapter } = await activate(t, fixture, {});
  await adapter.flush(); assert.equal(local.requests.length, 0);
});
