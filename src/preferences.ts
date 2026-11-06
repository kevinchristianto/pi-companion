/** Local display preference only. It never changes observer data or agent liveness. */
export const SHOW_IDLE_AGENTS_KEY = 'pi-companion.show-idle-agents';

export function loadShowIdleAgents(): boolean {
  try { return localStorage.getItem(SHOW_IDLE_AGENTS_KEY) !== 'false'; }
  catch { return true; }
}

export function saveShowIdleAgents(show: boolean): void {
  // Restricted storage must not prevent changing the current view.
  try { localStorage.setItem(SHOW_IDLE_AGENTS_KEY, String(show)); } catch { /* Session-only when storage is unavailable. */ }
}
