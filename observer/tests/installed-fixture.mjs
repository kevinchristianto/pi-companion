/** Relocatable test-only install; every credential here is a fixed public fixture. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const fixtureToken = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL_0123456789';
export const rotatedFixtureToken = 'TEST_ONLY_ROTATED_NOT_A_REAL_CREDENTIAL_9876543210';
const source = fileURLToPath(new URL('../', import.meta.url));
export async function installedFixture() {
  // realpath only canonicalizes the test's temporary base (e.g. macOS /tmp).
  // The production loader never canonicalizes an untrusted connection path.
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'Pi Companion relocated 空间 café '));
  const observer = path.join(root, 'observer');
  await fs.mkdir(observer, { mode: 0o700 });
  for (const name of ['index.ts', 'connection.ts', 'protocol.ts', 'subagents.ts', 'transport.ts'])
    await fs.copyFile(path.join(source, name), path.join(observer, name));
  const connectionFile = path.join(root, 'connection.json');
  return {
    root, observer, connectionFile,
    async load() { return import(pathToFileURL(path.join(observer, 'index.ts')).href); },
    async connect(url, token = fixtureToken) {
      const temporary = path.join(root, 'connection.next.json');
      await fs.writeFile(temporary, JSON.stringify({ version: 1, url, token }), { mode: 0o600 });
      await fs.rename(temporary, connectionFile);
    },
    async remove() { await fs.rm(root, { recursive: true, force: true }); },
  };
}
