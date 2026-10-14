import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { readConnection, parseConnection, validateOrigin } from '../connection.ts';
import { requestLocal } from '../transport.ts';
const token = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL_0123456789';
const config = (port = 4318) => ({version: 1, url: `http://127.0.0.1:${port}`, token});
async function temporary(t) {
  const base = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(base, 'pi-observer-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}
test('only canonical numeric IPv4 loopback origins are accepted', () => {
  assert.equal(validateOrigin('http://127.0.0.1:4318'), 'http://127.0.0.1:4318');
  for (const url of ['https://127.0.0.1:4318', 'http://localhost:4318', 'http://127.1:4318', 'http://2130706433:4318',
    'http://127.0.0.1:4318/', 'http://127.0.0.1:4318?token=x', 'http://127.0.0.1:4318#x', 'http://user@127.0.0.1:4318',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:04318', 'http://127.0.0.1:80',
    'http://evil.test:4318', 'http://[::1]:4318', ' http://127.0.0.1:4318']) assert.throws(() => validateOrigin(url), url);
});
test('connection JSON rejects malformed credential and version', () => {
  for (const input of [{}, {...config(), version: 2}, {...config(), token: 'short'}, {...config(), token: token+'\n'}, {...config(), token:'x'.repeat(513)}])
    assert.throws(() => parseConnection(input));
  assert.deepEqual(parseConnection(config()), {url: config().url, token});
});
test('bounded regular private file succeeds; unsafe files fail closed', async t => {
  const dir = await temporary(t), file = path.join(dir, 'connection.json');
  await fs.writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  assert.deepEqual(await readConnection(file), {url: config().url, token});
  await assert.rejects(readConnection('relative.json'));
  await assert.rejects(readConnection('//server/share/connection.json'));
  await assert.rejects(readConnection(dir));
  await fs.writeFile(file, 'x'.repeat(4097)); await assert.rejects(readConnection(file));
  await fs.writeFile(file, '{broken'); await assert.rejects(readConnection(file));
  await fs.writeFile(file, JSON.stringify(config()));
  if (process.platform !== 'win32') { await fs.chmod(file, 0o644); await assert.rejects(readConnection(file)); await fs.chmod(file, 0o600); }
  await t.test('final-component file symlink is rejected', async subtest => {
    const link = path.join(dir, 'alias.json');
    try { await fs.symlink(file, link); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        subtest.skip('This Windows account cannot create file symlinks; junction rejection is still tested'); return;
      }
      throw error;
    }
    await assert.rejects(readConnection(link));
  });
  const parentLink = path.join(dir, 'parent-link');
  await fs.symlink(dir, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readConnection(path.join(parentLink,'connection.json')));
  const hard = path.join(dir, 'hard.json'); await fs.link(file, hard); await assert.rejects(readConnection(file));
});
test('HTTP transport authenticates only local routes and ignores proxy env', async t => {
  let request;
  const port = await serve(t, (req,res) => { request=req; req.resume(); res.end('{"ok":true}'); });
  const result = await requestLocal(parseConnection(config(port)), '/api/ingest', {version:1});
  assert.equal(result.status,200); assert.equal(request.url, '/api/ingest');
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  await assert.rejects(requestLocal({url:'http://example.com:4318',token},'/api/ingest',{}));
  await assert.rejects(requestLocal(parseConnection(config(port)),'/redirect',{}));
  await assert.rejects(requestLocal(parseConnection(config(port)),'/api/ingest',{x:'x'.repeat(256*1024)}));
});
test('redirects are rejected, never followed', async t => {
  let redirected = 0;
  const destination = await serve(t, (_req,res) => { redirected++; res.end('{}'); });
  const port = await serve(t, (_req,res) => { res.writeHead(307,{location:`http://127.0.0.1:${destination}/secret`}); res.end(); });
  await assert.rejects(requestLocal(parseConnection(config(port)),'/api/hello',{})); assert.equal(redirected,0);
});
test('response and wall-clock bounds apply even to loopback', async t => {
  const large = await serve(t, (_req,res) => res.end('x'.repeat(8193)));
  await assert.rejects(requestLocal(parseConnection(config(large)),'/api/hello',{}));
  const silent = await serve(t, (_req,_res) => {});
  const start = performance.now();
  await assert.rejects(requestLocal(parseConnection(config(silent)),'/api/hello',{}));
  assert.ok(performance.now()-start < 1600);
});
