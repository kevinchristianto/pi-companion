/** Independent wire contract. No renderer, Tauri, or Pi package imports. */
export type AgentState = "idle" | "thinking" | "working" | "waiting" | "completed" | "error" | "stale" | "offline";
export interface Lifecycle {
  version: 1;
  eventId: string;
  kind: "start" | "stop";
  source: string;
  at: string;
}
export interface Agent {
  id: string;
  name: string;
  role: string;
  state: AgentState;
  tool?: string | null;
  model?: string | null;
  lifecycle?: Lifecycle;
}
export interface Snapshot {
  version: 1;
  streamId?: string;
  source?: { generation: number; sequence: number };
  session: {
    id: string;
    name: string;
    cwd: string;
    model: string | null;
    connected: boolean;
    agentsComplete: true;
    omittedAgentCount?: number;
    agents: Agent[];
  };
  capabilities: { pi: true; subagents: boolean; fleet: boolean; metadataOnly: true; omittedAgents: number };
}
export const MAX_AGENTS = 64;
export const MAX_BODY_BYTES = 256 * 1024;
export const HEARTBEAT_MS = 10_000;
export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function identity(value: unknown, max = 240): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max &&
    !/\p{Cc}/u.test(value) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) ? value : null;
}
export function display(value: unknown, max = 160): string {
  if (typeof value !== "string") return "";
  // Never cut a surrogate pair: Rust's JSON parser correctly rejects lone surrogates.
  const safe = value.replace(/\p{Cc}/gu, " ")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
  return Array.from(safe).slice(0, max).join("");
}
export function modelName(value: unknown): string | null {
  return display(record(value) ? value.id : value) || null;
}
export function stateName(value: unknown): AgentState {
  switch (value) {
    case "idle": case "thinking": case "working": case "waiting": case "completed":
    case "error": case "stale": case "offline": return value;
    case "queued": case "pending": case "paused": case "stopping": return "waiting";
    case "complete": case "done": case "succeeded": return "completed";
    case "failed": return "error";
    case "stopped": case "aborted": case "cancelled": return "offline";
    default: return "working";
  }
}
