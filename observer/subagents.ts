import { randomUUID, createHash } from "node:crypto";
import { display, identity, MAX_AGENTS, modelName, record, stateName, type Agent, type Lifecycle } from "./protocol.ts";

export interface EventBus {
  on(name: string, handler: (value: unknown) => void): (() => void) | void;
  emit(name: string, value: unknown): void;
}
/** Optional nicobailon/pi-subagents v1 integration. Only ping and untargeted status are emitted. */
export class SubagentObserver {
  private bus: EventBus;
  private changed: (agents: Agent[], omitted: number, supported: boolean) => void;
  private cleanups: (() => void)[] = [];
  private cancellations = new Set<() => void>();
  private active = true;
  private busy = false;
  private again = false;
  private negotiated = false;
  private fleet = false;
  private rows = new Map<string, Agent>();
  private observationId = randomUUID();
  private revision = 0;
  private epoch = 0;
  private lastMarkerAt = 0;
  constructor(bus: EventBus, changed: (agents: Agent[], omitted: number, supported: boolean) => void) {
    this.bus = bus; this.changed = changed;
    for (const name of ["subagents:rpc:v1:ready", "subagent:async-started", "subagent:async-complete", "subagent:child-status"]) {
      try {
        const off = bus.on(name, (value) => {
          if (!this.active) return;
          if (name === "subagent:child-status" && (!record(value) || value.version !== 1 || value.type !== "subagent.child-status")) return;
          if (name === "subagents:rpc:v1:ready") { this.epoch++; this.negotiated = false; this.fleet = false; }
          // A hint is not identity or completion proof: opaque fleet keys cannot be mapped to run IDs.
          void this.refresh();
        });
        if (typeof off === "function") this.cleanups.push(off);
      } catch { /* An optional plugin cannot disable the root observer. */ }
    }
  }
  private rpc(method: "ping" | "status"): Promise<Record<string, unknown> | null> {
    if (!this.active) return Promise.resolve(null);
    return new Promise((resolve) => {
      const requestId = randomUUID();
      let done = false;
      let off: (() => void) | void;
      const finish = (value: Record<string, unknown> | null) => {
        if (done) return;
        done = true; clearTimeout(timer); this.cancellations.delete(cancel);
        try { off?.(); } catch { /* Cleanup is best effort for an optional bus. */ }
        resolve(this.active ? value : null);
      };
      const cancel = () => finish(null);
      const timer = setTimeout(cancel, 800); timer.unref?.();
      this.cancellations.add(cancel);
      try {
        off = this.bus.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
          if (!record(reply) || reply.version !== 1 || reply.requestId !== requestId) return;
          finish(reply.success === true && record(reply.data) ? reply.data : null);
        });
        if (done) { try { off?.(); } catch {} return; }
        this.bus.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params: {} });
      } catch { finish(null); }
    });
  }
  async refresh(): Promise<void> {
    if (!this.active) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    const epoch = this.epoch;
    try {
      if (!this.negotiated) {
        const ping = await this.rpc("ping");
        if (!this.active || epoch !== this.epoch || !ping) return;
        this.negotiated = true;
        this.fleet = record(ping.capabilities) && record(ping.capabilities.fleetStatus) && ping.capabilities.fleetStatus.version === 1;
        if (!this.fleet) { this.changed([], 0, false); return; }
      }
      if (!this.fleet) return;
      const status = await this.rpc("status");
      if (!this.active || epoch !== this.epoch || !status || !record(status.fleet) || status.fleet.version !== 1 || !Array.isArray(status.fleet.entries)) return;
      const entries = status.fleet.entries;
      const next = new Map<string, Agent>();
      // Work is bounded even if another extension publishes an unexpectedly large object.
      const candidates = entries.slice(0, 1024).filter(record).filter(entry => identity(entry.key, 4096) !== null).sort((a, b) => {
        const terminal = (item: Record<string, unknown>) => ["completed", "error", "offline"].includes(stateName(item.state ?? item.status)) ? 1 : 0;
        return terminal(a) - terminal(b) || ((a.key as string) < (b.key as string) ? -1 : (a.key === b.key ? 0 : 1));
      });
      for (const entry of candidates) {
        if (next.size >= MAX_AGENTS - 1) break;
        if (!record(entry)) continue;
        const key = identity(entry.key, 4096);
        if (!key) continue;
        const id = `child:${createHash("sha256").update(key).digest("hex")}`;
        if (next.has(id)) continue;
        const old = this.rows.get(id);
        const state = stateName(entry.state ?? entry.status);
        const terminal = ["completed", "error", "offline"].includes(state);
        let lifecycle: Lifecycle | undefined = old?.lifecycle;
        if (!old || (old.lifecycle?.kind === "stop" && !terminal) || (old.lifecycle?.kind !== "stop" && terminal)) {
          this.lastMarkerAt = Math.max(Date.now(), this.lastMarkerAt + 1);
          lifecycle = { version: 1, eventId: `${this.observationId}:${++this.revision}`, kind: terminal ? "stop" : "start", source: "pi-subagents:fleet", at: new Date(this.lastMarkerAt).toISOString() };
        }
        next.set(id, { id, name: display(entry.agent) || "Subagent", role: display(entry.role) || "subagent", state,
          model: modelName(entry.model), tool: display(entry.currentTool) || null, ...(lifecycle ? { lifecycle } : {}) });
      }
      const upstreamOmitted = Number.isSafeInteger(status.fleet.omitted) && (status.fleet.omitted as number) >= 0 ? status.fleet.omitted as number : 1;
      const omitted = Math.min(Math.floor(Number.MAX_SAFE_INTEGER / 24), upstreamOmitted + Math.max(0, entries.length - next.size));
      // Only a complete authoritative projection removes absent agents. Truncated projections retain the prior bounded roster.
      if (omitted > 0) for (const [id, row] of this.rows) if (!next.has(id) && next.size < MAX_AGENTS - 1) next.set(id, { ...row, state: "stale", tool: null });
      this.rows = next;
      this.changed([...next.values()], omitted, true);
    } catch { /* Never expose provider error text or affect Pi. */ }
    finally {
      this.busy = false;
      if (this.again && this.active) { this.again = false; queueMicrotask(() => { void this.refresh(); }); }
    }
  }
  close(): void {
    this.active = false; this.again = false;
    for (const cancel of this.cancellations) cancel();
    this.cancellations.clear();
    for (const off of this.cleanups) { try { off(); } catch {} }
    this.cleanups = []; this.rows.clear();
  }
}
