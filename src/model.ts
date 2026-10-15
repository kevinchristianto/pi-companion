/** The renderer receives complete snapshots, never process guesses or activity-derived liveness. */
export const AGENT_STATES = ['idle', 'working', 'thinking', 'waiting', 'error', 'completed', 'stale', 'offline', 'unknown'] as const;
export type AgentState = typeof AGENT_STATES[number];
export interface Agent {
  key: string;
  sessionId: string;
  agentId: string;
  name: string;
  sessionName: string;
  /** Exact observer-provided workspace identity; never a renderer filesystem path. */
  cwd?: string;
  role: string;
  task: string;
  state: AgentState;
  tool?: string;
  model?: string;
}
export type BridgeStatus = 'starting' | 'listening' | 'error' | 'stopped';
export type WindowMode = 'office' | 'taskbar';
export interface WindowState {
  pinned: boolean;
  clickThrough: boolean;
  recoveryAvailable?: boolean;
  /** Older native envelopes remain office windows. */
  mode?: WindowMode;
  fullscreenHidden?: boolean;
}
export interface ShellState {
  sequence: number;
  snapshot: { streamId: string; revision: number; agents: Agent[]; omittedAgentCount?: number };
  bridge: { status: BridgeStatus; message?: string; connectionFile?: string; observerEntry?: string };
  window: WindowState;
}
export const EMPTY_STATE: ShellState = {
  sequence: 0,
  snapshot: { streamId: '', revision: 0, agents: [] },
  bridge: { status: 'starting' },
  window: { pinned: false, clickThrough: false, mode: 'office', fullscreenHidden: false },
};
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 8192): value is string => typeof value === 'string' && value.length <= max;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const optionalText = (value: unknown): boolean => value === undefined || text(value);
const optionalAgentText = (value: unknown): boolean => value === null || optionalText(value);
const optionalWorkspace = (value: unknown): boolean => value === undefined || value === null || (text(value, 4096) && !/\p{Cc}/u.test(value) && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value));

/** Untrusted bridge values never become markup, paths, sprite keys, or commands. */
export function parseShellState(value: unknown): ShellState | null {
  if (!object(value) || !integer(value.sequence) || !object(value.snapshot) || !object(value.bridge) || !object(value.window)) return null;
  const { snapshot, bridge, window } = value;
  if ((snapshot.version !== undefined && snapshot.version !== 1) || (snapshot.omittedAgentCount !== undefined && !integer(snapshot.omittedAgentCount))) return null;
  if (!text(snapshot.streamId, 256) || !integer(snapshot.revision) || !Array.isArray(snapshot.agents) || snapshot.agents.length > 1536) return null;
  if (typeof bridge.status !== 'string' || !['starting', 'listening', 'error', 'stopped'].includes(bridge.status) || !optionalText(bridge.message) || !optionalText(bridge.connectionFile) || !optionalText(bridge.observerEntry)) return null;
  if (typeof window.pinned !== 'boolean' || typeof window.clickThrough !== 'boolean' || (window.recoveryAvailable !== undefined && typeof window.recoveryAvailable !== 'boolean')) return null;
  if ((window.mode !== undefined && window.mode !== 'office' && window.mode !== 'taskbar') || (window.fullscreenHidden !== undefined && typeof window.fullscreenHidden !== 'boolean')) return null;
  const keys = new Set<string>();
  for (const agent of snapshot.agents) {
    if (!object(agent) || !['key', 'sessionId', 'agentId', 'name', 'sessionName', 'role', 'task'].every(key => text(agent[key]))) return null;
    if (!agent.key || !agent.sessionId || !agent.agentId || keys.has(agent.key as string)) return null;
    if (!AGENT_STATES.includes(agent.state as AgentState) || !optionalAgentText(agent.tool) || !optionalAgentText(agent.model) || !optionalWorkspace(agent.cwd)) return null;
    keys.add(agent.key as string);
  }
  // Copy accepted data: callers cannot mutate an accepted snapshot through its input object.
  return {
    sequence: value.sequence,
    snapshot: { streamId: snapshot.streamId, revision: snapshot.revision, ...(snapshot.omittedAgentCount === undefined ? {} : { omittedAgentCount: snapshot.omittedAgentCount as number }), agents: snapshot.agents.map(a => ({ key: a.key, sessionId: a.sessionId, agentId: a.agentId, name: a.name, sessionName: a.sessionName, ...(typeof a.cwd === 'string' && a.cwd.trim() ? { cwd: a.cwd } : {}), role: a.role, task: a.task, state: a.state, ...(typeof a.tool === 'string' ? { tool: a.tool } : {}), ...(typeof a.model === 'string' ? { model: a.model } : {}) })) as Agent[] },
    bridge: { status: bridge.status as BridgeStatus, ...(bridge.message === undefined ? {} : { message: bridge.message as string }), ...(bridge.connectionFile === undefined ? {} : { connectionFile: bridge.connectionFile as string }), ...(bridge.observerEntry === undefined ? {} : { observerEntry: bridge.observerEntry as string }) },
    window: { pinned: window.pinned, clickThrough: window.clickThrough, mode: (window.mode ?? 'office') as WindowMode, fullscreenHidden: window.fullscreenHidden === true, ...(window.recoveryAvailable === undefined ? {} : { recoveryAvailable: window.recoveryAvailable }) },
  };
}

export function failClosed(previous: ShellState, message: string): ShellState {
  return { ...previous, snapshot: { ...previous.snapshot, agents: [] }, bridge: { status: 'error', message } };
}
export function liveAgents(state: ShellState): Agent[] {
  return state.bridge.status === 'listening' ? state.snapshot.agents.filter(agent => agent.state !== 'stale' && agent.state !== 'offline') : [];
}
export const STATE_LABELS: Record<AgentState, string> = {
  idle: 'Ready', working: 'Working', thinking: 'Thinking', waiting: 'Needs input',
  error: 'Error', completed: 'Completed', stale: 'Stale', offline: 'Offline', unknown: 'Unknown',
};
export function statusLabel(agent: Agent): string {
  return agent.state === 'working' && agent.tool ? `Using ${agent.tool}` : STATE_LABELS[agent.state];
}

/** Envelope sequence orders BOTH window controls and snapshots; snapshots may reuse a revision. */
export class StateStore {
  current: ShellState = structuredClone(EMPTY_STATE);
  private sequence = -1;
  accept(input: unknown): 'accepted' | 'stale' | 'invalid' {
    const next = parseShellState(input);
    if (!next) {
      this.current = failClosed(this.current, 'The companion received an invalid update. Live agents are hidden until a valid snapshot arrives.');
      return 'invalid';
    }
    if (next.sequence <= this.sequence) return 'stale';
    if (next.snapshot.streamId === this.current.snapshot.streamId && next.snapshot.revision < this.current.snapshot.revision) {
      this.current = failClosed(this.current, 'The companion received an out-of-order snapshot. Waiting for a fresh update.');
      this.sequence = next.sequence;
      return 'invalid';
    }
    this.sequence = next.sequence;
    this.current = next;
    return 'accepted';
  }
  disconnect(message: string): void { this.current = failClosed(this.current, message); }
}
