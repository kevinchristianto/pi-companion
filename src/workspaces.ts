import type { Agent } from './model';

export interface Workspace {
  /** Collision-free identity, independent of display names and current membership. */
  key: string;
  name: string;
  label: string;
  cwd?: string;
  sessionIds: string[];
  agents: Agent[];
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const knownCwd = (agent: Agent): string | undefined => agent.cwd?.trim() ? agent.cwd : undefined;
const display = (value: string): string => value.replace(/[\p{Cc}\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu, '');

/** Canonicalization belongs to the source. Never merge by basename, case, or path aliases. */
export function workspaceKey(agent: Agent): string {
  const cwd = knownCwd(agent);
  // Missing workspace metadata cannot establish that unrelated sessions share a project.
  return JSON.stringify(cwd === undefined ? ['session', agent.sessionId] : ['cwd', cwd]);
}

function workspaceName(cwd: string): string {
  // Separators affect presentation only; the exact original string stays the identity.
  const windows = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\\\');
  const pieces = cwd.split(windows ? /[\\/]/ : /\//).filter(Boolean);
  return display(pieces.at(-1) || cwd) || 'Workspace';
}

/** Pass the authoritative live roster; grouping never infers or extends agent liveness. */
export function groupWorkspaces(agents: readonly Agent[]): Workspace[] {
  const grouped = new Map<string, Workspace>();
  for (const agent of agents) {
    const key = workspaceKey(agent);
    let workspace = grouped.get(key);
    if (!workspace) {
      const cwd = knownCwd(agent);
      workspace = { key, name: '', label: '', ...(cwd === undefined ? {} : { cwd }), sessionIds: [], agents: [] };
      grouped.set(key, workspace);
    }
    workspace.agents.push(agent);
    if (!workspace.sessionIds.includes(agent.sessionId)) workspace.sessionIds.push(agent.sessionId);
  }
  const workspaces = [...grouped.values()];
  for (const workspace of workspaces) {
    workspace.sessionIds.sort(compare);
    if (workspace.cwd !== undefined) {
      workspace.name = workspaceName(workspace.cwd);
      workspace.label = workspace.name;
    } else {
      workspace.name = workspace.agents.map(agent => display(agent.sessionName)).filter(name => name.trim()).sort(compare)[0] || 'Untitled session';
      workspace.label = `${workspace.name} · Unknown workspace`;
    }
  }
  const totals = new Map<string, number>();
  for (const workspace of workspaces) totals.set(workspace.label, (totals.get(workspace.label) || 0) + 1);
  for (const workspace of workspaces) {
    if (totals.get(workspace.label)! > 1) {
      workspace.label += ` · ${display(workspace.cwd ?? workspace.sessionIds[0])}`;
    }
  }
  // Also handle a literal directory name matching a generated label, or invisible
  // display characters. Labels remain distinct without changing workspace identity.
  const reserved = new Set(workspaces.map(workspace => workspace.label));
  const used = new Set<string>();
  for (const workspace of [...workspaces].sort((a, b) => compare(a.key, b.key))) {
    const base = workspace.label;
    let ordinal = 1;
    while (used.has(workspace.label)) {
      do { workspace.label = `${base} · ${++ordinal}`; } while (reserved.has(workspace.label));
    }
    used.add(workspace.label);
  }
  return workspaces.sort((a, b) => compare(a.label, b.label) || compare(a.key, b.key));
}

/** A vanished project releases its filter instead of stranding the roster on an empty view. */
export function reconcileWorkspaceSelection(workspaces: readonly Workspace[], selected: string): string {
  return workspaces.some(workspace => workspace.key === selected) ? selected : '';
}
