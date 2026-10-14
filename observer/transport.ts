import http from "node:http";
import { performance } from "node:perf_hooks";
import { parseConnection, type Connection } from "./connection.ts";
import { MAX_BODY_BYTES, record, identity, type Snapshot } from "./protocol.ts";

export interface Reply { status: number; body: unknown }
export type Request = (connection: Connection, route: "/api/hello" | "/api/ingest", body: unknown) => Promise<Reply>;
/** node:http does not follow redirects or honor HTTP_PROXY; only this exact loopback origin is allowed. */
export const requestLocal: Request = async (connection, route, body) => {
  const validated = parseConnection({ version: 1, ...connection });
  if (route !== "/api/hello" && route !== "/api/ingest") throw new Error("Unsupported observer route");
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.length > MAX_BODY_BYTES) throw new Error("Observer snapshot exceeds byte limit");
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error?: Error, result?: Reply) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (error) reject(new Error("Local observer request failed")); else resolve(result!);
    };
    const req = http.request(`${validated.url}${route}`, {
      method: "POST", agent: false,
      headers: { "authorization": `Bearer ${validated.token}`, "content-type": "application/json", "content-length": bytes.length },
    }, (res) => {
      let size = 0;
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) { res.destroy(); req.destroy(); finish(new Error("Response exceeds limit")); }
        else chunks.push(chunk);
      });
      res.on("error", () => finish(new Error("Response failed")));
      res.on("end", () => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) { finish(new Error("Redirect refused")); return; }
        let data: unknown = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* Empty acknowledgements are valid. */ }
        finish(undefined, { status, body: data });
      });
    });
    // A wall-clock deadline, not just the socket inactivity timeout.
    const deadline = setTimeout(() => { req.destroy(); finish(new Error("Deadline")); }, 750);
    deadline.unref?.();
    req.on("error", () => finish(new Error("Request failed")));
    req.end(bytes);
  });
};

/** Single-flight, latest-only queue. No event can launch an overlapping request. */
export class SnapshotTransport {
  private load: () => Promise<Connection>;
  private request: Request;
  private sessionId: string;
  private instanceId: string;
  private connection: Connection | null = null;
  private generation: number | null = null;
  private sequence = 0;
  private streamId: string | null = null;
  private pending: Snapshot | null = null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAfter = 0;
  private closing = false;
  private closingPromise: Promise<void> | null = null;
  private closed = false;
  private superseded = false;
  constructor(load: () => Promise<Connection>, sessionId: string, instanceId: string, request: Request = requestLocal) {
    this.load = load; this.sessionId = sessionId; this.instanceId = instanceId; this.request = request;
  }
  submit(snapshot: Snapshot): void {
    if (this.closed || this.closing || this.superseded) return;
    this.pending = structuredClone(snapshot);
    this.schedule();
  }
  private schedule(): void {
    if (this.timer || this.running || !this.pending || this.closed || this.closing || this.superseded) return;
    const delay = Math.max(75, this.retryAfter - performance.now());
    this.timer = setTimeout(() => { this.timer = null; void this.pump(); }, delay);
    this.timer.unref?.();
  }
  private async transmit(snapshot: Snapshot): Promise<void> {
    if (!this.connection || this.generation === null) {
      this.connection = await this.load();
      const reply = await this.request(this.connection, "/api/hello", { version: 1, sessionId: this.sessionId, instanceId: this.instanceId });
      if (reply.status === 409) { this.superseded = true; throw new Error("Observer lease superseded"); }
      const source = record(reply.body) && record(reply.body.source) ? reply.body.source : null;
      if (reply.status < 200 || reply.status >= 300 || !record(reply.body) || !identity(reply.body.streamId) || !source ||
          !Number.isSafeInteger(source.generation) || (source.generation as number) < 1)
        throw new Error("Local bridge handshake failed");
      this.generation = source.generation as number;
      this.streamId = reply.body.streamId as string;
    }
    const reply = await this.request(this.connection, "/api/ingest", {
      ...snapshot, streamId: this.streamId, source: { generation: this.generation, sequence: ++this.sequence },
    });
    if (reply.status < 200 || reply.status >= 300) throw new Error("Local bridge did not accept snapshot");
  }
  private pump(): Promise<void> {
    if (this.running) return this.running;
    if (!this.pending || this.closed || this.superseded) return Promise.resolve();
    const next = this.pending;
    this.pending = null;
    const work = (async () => {
      try { await this.transmit(next); this.retryAfter = 0; }
      catch {
        // No exception text, response body, token, prompt or tool content is logged.
        this.connection = null; this.generation = null; this.streamId = null;
        this.retryAfter = performance.now() + 5000;
        if (!this.closing && !this.pending) this.pending = next;
      }
    })();
    this.running = work.finally(() => { this.running = null; this.schedule(); });
    return this.running;
  }
  /** Await at most the in-flight attempt and one final disconnected snapshot attempt. */
  close(snapshot: Snapshot): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.closingPromise = (async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.pending = null;
      await this.running;
      this.pending = structuredClone(snapshot);
      await this.pump();
      this.pending = null;
      this.closed = true;
    })();
    return this.closingPromise;
  }
  /** Test/explicit flush; ordinary Pi handlers never wait for network I/O. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
    if (this.pending) await this.pump();
  }
}
