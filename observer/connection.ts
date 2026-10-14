import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { record } from "./protocol.ts";

export interface Connection { url: string; token: string }
export const MAX_CONNECTION_BYTES = 4096;
/** Deliberately require canonical IPv4 loopback. No DNS, proxy, URL credentials or redirects. */
export function validateOrigin(value: unknown): string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value))
    throw new Error("Invalid local bridge address");
  const url = new URL(value);
  if (Number(url.port) < 1 || Number(url.port) > 65535 || url.origin !== value)
    throw new Error("Invalid local bridge address");
  return value;
}
export function parseConnection(value: unknown): Connection {
  if (!record(value) || value.version !== 1 || typeof value.token !== "string" ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(value.token)) throw new Error("Invalid local connection file");
  return { url: validateOrigin(value.url), token: value.token };
}
/** File-only credentials. The size-limited read never follows a final-component symlink. */
export async function readConnection(file: string): Promise<Connection> {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.length > 4096 ||
      /[\u0000-\u001f\u007f]/.test(file) || /^[/\\]{2}/.test(file))
    throw new Error("Connection file must be an absolute local path");
  const target = path.resolve(file);
  // Reject symlinks/junctions at every existing component, including parent directories.
  const root = path.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Connection path contains a symlink");
  }
  const before = await fs.lstat(target);
  const check = (stat: typeof before) => {
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_CONNECTION_BYTES)
      throw new Error("Connection file is not a bounded regular file");
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())))
      throw new Error("Connection file must be private to its owner");
  };
  check(before);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    check(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("Connection file changed");
    const bytes = Buffer.alloc(MAX_CONNECTION_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const pathname = await fs.lstat(target);
    check(after);
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        pathname.isSymbolicLink() || pathname.dev !== opened.dev || pathname.ino !== opened.ino)
      throw new Error("Connection file changed while reading");
    return parseConnection(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally { await handle.close(); }
}
