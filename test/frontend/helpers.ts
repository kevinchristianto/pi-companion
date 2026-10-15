import type { Agent, ShellState } from '../../src/model';
import type { Platform, WindowCommand } from '../../src/platform';
export const agent = (number = 0, override: Partial<Agent> = {}): Agent => ({ key: `session-a/${number}`, sessionId: 'session-a', agentId: String(number), name: `Agent ${number}`, sessionName: 'Workshop', role: number ? 'subagent' : 'orchestrator', task: 'A useful task.', state: 'idle', ...override });
export const state = (agents: Agent[] = [agent()], sequence = 1): ShellState => ({ sequence, snapshot: { streamId: 'stream-a', revision: sequence, agents }, bridge: { status: 'listening', connectionFile: '/local/config/connection.json' }, window: { pinned: false, clickThrough: false, recoveryAvailable: true } });
export class TestPlatform implements Platform {
  review = false;
  current = state();
  listener?: (value: unknown) => void;
  commands: WindowCommand[] = [];
  reads = 0;
  unsubscribed = false;
  failure?: Error;
  async subscribe(listener: (value: unknown) => void) { this.listener = listener; return () => { this.unsubscribed = true; }; }
  async getState() { this.reads++; return structuredClone(this.current); }
  async command(command: WindowCommand): Promise<unknown> {
    this.commands.push(command); if (this.failure) throw this.failure;
    this.current = { ...this.current, sequence: this.current.sequence + 1, window: { ...this.current.window } };
    if (command.name === 'set_pinned') this.current.window.pinned = command.args.pinned;
    if (command.name === 'set_click_through') this.current.window.clickThrough = command.args.enabled;
    if (command.name === 'set_window_mode') { this.current.window.mode = command.args.mode; this.current.window.fullscreenHidden = false; }
    return structuredClone(this.current);
  }
  emit(value: unknown) { this.listener?.(value); }
}
