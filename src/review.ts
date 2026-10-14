import type { Agent, AgentState, ShellState } from './model';
import type { Platform } from './platform';
import { DESIGN_IDS, designForIdentity } from './sprites';

/** Explicit serve-only fixtures. Never a fallback for a missing desktop or broken bridge. */
export function reviewPlatform(): Platform {
  if (!import.meta.env.DEV || !__REVIEW_SERVE__) throw new Error('Review fixtures are unavailable in this build');
  const names = ['Moss', 'Amber', 'Plum', 'Sky', 'Coral', 'Sage'];
  const states: AgentState[] = ['working', 'thinking', 'waiting', 'idle', 'error', 'working'];
  const tasks = ['Building the next thoughtful little thing.', 'Reviewing the implementation plan.', 'Waiting for your choice of approach.', 'Ready when you are.', 'A test needs a closer look.', 'Checking the final details.'];
  const agents: Agent[] = DESIGN_IDS.map((design, index) => {
    let key = `${index}`; for (let candidate = 0; candidate < 1000; candidate++) { key = `review-${index}-${candidate}`; if (designForIdentity(key) === design) break; }
    return { key, cwd: index < 4 ? '/Projects/pi-companion' : '/Projects/side-project', sessionId: index < 3 ? 'review-workshop' : 'review-studio', agentId: `sample-${index}`, name: names[index], sessionName: index < 3 ? 'Companion workshop' : 'Small ideas studio', role: index === 0 || index === 3 ? 'orchestrator' : 'subagent', task: tasks[index], state: states[index], ...(index === 0 ? { tool: 'edit' } : {}), model: 'Review fixture' };
  });
  let state: ShellState = { sequence: 1, snapshot: { streamId: 'explicit-dev-review', revision: 1, agents }, bridge: { status: 'listening' }, window: { pinned: false, clickThrough: false, recoveryAvailable: true } };
  const listeners = new Set<(value: unknown) => void>();
  return {
    review: true,
    async subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async getState() { return structuredClone(state); },
    async command(command) {
      if (command.name === 'hide_window') throw new Error('Hide is a desktop-only action. This review stays visible.');
      if (command.name === 'start_dragging') return;
      if (command.name === 'set_click_through') throw new Error('Pass-through requires the native desktop tray and recovery shortcut.');
      if (command.name === 'set_pinned') state = { ...state, sequence: state.sequence + 1, window: { ...state.window, pinned: command.args.pinned } };
      if (command.name === 'resize_window') throw new Error('Resize the browser viewport to review this layout. Native size presets work in the desktop app.');
      for (const listener of listeners) listener(structuredClone(state));
      return structuredClone(state);
    },
  };
}
