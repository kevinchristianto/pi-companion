/** Load in Pi only: register the installed observer/index.ts once in Pi's extensions array. */
import { randomUUID } from "node:crypto";
import { loadObserverConnection } from "./connection.ts";
import { display, HEARTBEAT_MS, identity, modelName, record, type Agent, type Snapshot } from "./protocol.ts";
import { SubagentObserver, type EventBus } from "./subagents.ts";
import { SnapshotTransport, type Request } from "./transport.ts";
import type { Connection } from "./connection.ts";

type Data = Record<string, unknown>;
export interface PiContext {
  cwd?: string;
  model?: unknown;
  sessionManager?: { getSessionId(): string };
  isIdle?: () => boolean;
  hasUI?: boolean;
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
type Handler = (event: Data, context: PiContext) => void | Promise<void>;
/** Read-only structural subset avoids tying the adapter to a Pi package rename. */
export interface Pi {
  on(name: string, handler: Handler): unknown;
  getSessionName?: () => string | undefined;
  events?: EventBus;
}
interface Runtime {
  context: PiContext;
  snapshot: Snapshot;
  transport: SnapshotTransport;
  children?: SubagentObserver;
  heartbeat: ReturnType<typeof setInterval>;
  tools: Map<string, string>;
  busy: boolean;
  prompts: number;
  closed: boolean;
  overflowWarned: boolean;
}
export interface ObserverOptions {
  loadConnection?: () => Promise<Connection>;
  request?: Request;
  heartbeatMs?: number;
}
/** Dependency injection is for tests; the extension entry uses file-only credentials and fixed loopback HTTP. */
export function installObserver(pi: Pi, options: ObserverOptions = {}) {
  let active: Runtime | null = null;
  let intent = 0;
  let pendingSessionId: string | null = null;
  let transitions: Promise<void> = Promise.resolve();
  const load = options.loadConnection || (() => loadObserverConnection(import.meta.url));
  const publish = (runtime: Runtime) => { if (!runtime.closed) runtime.transport.submit(runtime.snapshot); };
  const root = (runtime: Runtime): Agent => runtime.snapshot.session.agents[0]!;
  const lifecycle = (kind: "start" | "stop", source: string) => ({ version: 1 as const, eventId: randomUUID(), kind, source, at: new Date().toISOString() });
  async function retire(runtime: Runtime | null) {
    if (!runtime || runtime.closed) return;
    runtime.closed = true;
    clearInterval(runtime.heartbeat);
    runtime.children?.close(); runtime.tools.clear();
    runtime.snapshot.session.connected = false;
    for (const agent of runtime.snapshot.session.agents) {
      agent.state = "offline"; agent.tool = null;
      agent.lifecycle = lifecycle("stop", "pi:session_shutdown");
    }
    await runtime.transport.close(runtime.snapshot);
  }
  function matches(runtime: Runtime, ctx: PiContext): boolean {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      return !sessionId || sessionId === runtime.snapshot.session.id;
    } catch { return false; }
  }
  function current(ctx: PiContext): Runtime | null { return active && !active.closed && matches(active, ctx) ? active : null; }
  function refreshState(runtime: Runtime) {
    const main = root(runtime);
    main.state = runtime.prompts > 0 ? "waiting" : runtime.tools.size > 0 ? "working" : runtime.busy ? "thinking" : "idle";
    main.tool = [...runtime.tools.values()].at(-1) || null;
    publish(runtime);
  }
  function on(name: string, handler: Handler) {
    try {
      pi.on(name, (event, ctx) => {
        try {
          const result = handler(record(event) ? event : {}, ctx || {});
          if (result instanceof Promise) return result.catch(() => undefined);
        } catch { /* Observational failure must never alter a Pi turn. */ }
      });
    } catch { /* Older Pi versions can lack newer notification-only events. */ }
  }
  on("session_start", (_event, ctx) => {
    const requested = ++intent;
    // Capture plain metadata before any asynchronous teardown; do not retain transcript access.
    let id: string | null = null;
    let name = "Pi session";
    let idle = true;
    try { id = identity(ctx.sessionManager?.getSessionId?.()); } catch {}
    try { name = display(pi.getSessionName?.()) || name; } catch {}
    try { idle = ctx.isIdle?.() !== false; } catch {}
    const sessionId = id || randomUUID();
    pendingSessionId = sessionId;
    const cwd = identity(ctx.cwd, 4096) || "";
    const model = modelName(ctx.model);
    transitions = transitions.then(async () => {
      const previous = active; active = null;
      await retire(previous);
      if (requested !== intent) return;
      pendingSessionId = null;
      const transport = new SnapshotTransport(load, sessionId, randomUUID(), options.request);
      const snapshot: Snapshot = { version: 1, session: { id: sessionId, name, cwd, model, connected: true, agentsComplete: true, omittedAgentCount: 0,
        agents: [{ id: "main", name: "Pi", role: "orchestrator", state: idle ? "idle" : "thinking", model, tool: null,
          lifecycle: lifecycle("start", "pi:session_start") }] },
        capabilities: { pi: true, subagents: false, fleet: false, metadataOnly: true, omittedAgents: 0 } };
      const runtime: Runtime = { context: ctx, snapshot, transport, heartbeat: undefined as unknown as ReturnType<typeof setInterval>, tools: new Map(), busy: !idle, prompts: 0, closed: false, overflowWarned: false };
      active = runtime;
      if (pi.events) runtime.children = new SubagentObserver(pi.events, (agents, omitted, supported) => {
        if (runtime.closed || active !== runtime) return;
        snapshot.session.agents = [root(runtime), ...agents];
        snapshot.capabilities.subagents = supported; snapshot.capabilities.fleet = supported; snapshot.capabilities.omittedAgents = omitted;
        snapshot.session.omittedAgentCount = omitted;
        if (omitted > 0 && !runtime.overflowWarned) {
          runtime.overflowWarned = true;
          try { if (ctx.hasUI !== false) ctx.ui?.notify("Pi Companion is showing a bounded roster of up to 63 children. Additional agents are omitted from the companion view.", "warning"); } catch {}
        } else if (omitted === 0) runtime.overflowWarned = false;
        publish(runtime);
      });
      runtime.heartbeat = setInterval(() => {
        if (runtime.closed || active !== runtime) return;
        // Renames on older versions are picked up without inspecting transcript entries.
        try { snapshot.session.name = display(pi.getSessionName?.()) || "Pi session"; } catch {}
        publish(runtime); void runtime.children?.refresh();
      }, options.heartbeatMs ?? HEARTBEAT_MS);
      runtime.heartbeat.unref?.();
      publish(runtime); void runtime.children?.refresh();
    }).catch(() => undefined);
    return transitions;
  });
  on("session_shutdown", (_event, ctx) => {
    // A shutdown for a pending replacement cancels that startup; an old runtime's
    // late shutdown must not cancel the replacement already requested after it.
    let incomingId: string | null = null;
    try { incomingId = identity(ctx.sessionManager?.getSessionId?.()); } catch {}
    if (pendingSessionId && incomingId && incomingId !== pendingSessionId) return;
    if (!pendingSessionId && active && !matches(active, ctx)) return;
    ++intent; pendingSessionId = null;
    transitions = transitions.then(async () => { const previous = active; active = null; await retire(previous); }).catch(() => undefined);
    return transitions;
  });
  on("session_info_changed", (event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    runtime.snapshot.session.name = display(event.name) || "Pi session"; publish(runtime);
  });
  on("agent_start", (_event, ctx) => { const runtime = current(ctx); if (!runtime) return; runtime.busy = true; refreshState(runtime); });
  on("agent_end", (_event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    // agent_end can precede an automatic continuation. Final idle normally comes from agent_settled.
    try { if (ctx.isIdle?.() === true) { runtime.busy = false; runtime.tools.clear(); refreshState(runtime); } } catch {}
  });
  on("agent_settled", (_event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    runtime.busy = false; runtime.prompts = 0; runtime.tools.clear(); refreshState(runtime); void runtime.children?.refresh();
  });
  on("tool_execution_start", (event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    const id = identity(event.toolCallId); const name = display(event.toolName);
    if (!id || !name || runtime.tools.size >= 256) return;
    runtime.tools.set(id, name); runtime.busy = true; refreshState(runtime);
  });
  on("tool_execution_end", (event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    const id = identity(event.toolCallId); if (id) runtime.tools.delete(id);
    refreshState(runtime);
  });
  on("model_select", (event, ctx) => {
    const runtime = current(ctx); if (!runtime) return;
    const model = modelName(event.model); runtime.snapshot.session.model = model; root(runtime).model = model; publish(runtime);
  });
  on("ui_prompt_start", (_event, ctx) => { const runtime = current(ctx); if (!runtime) return; runtime.prompts = Math.min(256, runtime.prompts + 1); refreshState(runtime); });
  on("ui_prompt_end", (_event, ctx) => { const runtime = current(ctx); if (!runtime) return; runtime.prompts = Math.max(0, runtime.prompts - 1); refreshState(runtime); });
  return {
    async flush() { await transitions; await active?.transport.flush(); },
    snapshot(): Snapshot | null { return active ? structuredClone(active.snapshot) : null; },
    async close() { ++intent; pendingSessionId = null; await transitions; const previous = active; active = null; await retire(previous); },
  };
}
export default function piCompanion(pi: Pi): void { installObserver(pi); }
