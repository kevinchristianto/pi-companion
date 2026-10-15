import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { Agent, WindowMode } from './model';
import { liveAgents, StateStore, STATE_LABELS, statusLabel } from './model';
import type { Platform, WindowCommand } from './platform';
import { RenderScheduler } from './scheduler';
import { animationForState, drawSprite, frameAt, ILLUSTRATED_LIMIT, loadSpriteAssets } from './sprites';
import type { SpriteAssets } from './sprites';
import { groupWorkspaces, reconcileWorkspaceSelection } from './workspaces';
import { Button } from './components/ui/8bit/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem } from './components/ui/8bit/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/8bit/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './components/ui/8bit/tooltip';

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The desktop command could not be completed. Try again from the tray.';
/** One authoritative store outside React. Rendering never manufactures liveness. */
function stateController(platform: Platform) {
  const store = new StateStore(); const listeners = new Set<() => void>();
  let disposed = false, updates = 0, request = 0; let unsubscribe: (() => void) | undefined;
  const publish = () => { if (!disposed) flushSync(() => { for (const listener of listeners) listener(); }); };
  const receive = (value: unknown) => { if (disposed) return; const result = store.accept(value); if (result === 'accepted') updates++; if (result !== 'stale') publish(); };
  const refresh = async () => {
    const id = ++request, atRequest = updates;
    try { receive(await platform.getState()); }
    catch (error) { if (!disposed && id === request && updates === atRequest) { store.disconnect(messageOf(error)); publish(); } }
  };
  const onVisibility = () => { if (!document.hidden) { store.disconnect('Refreshing the live connection…'); publish(); void refresh(); } };
  return {
    snapshot: () => store.current,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    receive,
    async start() {
      document.addEventListener('visibilitychange', onVisibility);
      try { const cleanup = await platform.subscribe(receive); if (disposed) { cleanup(); return; } unsubscribe = cleanup; await refresh(); }
      catch (error) { if (!disposed) { store.disconnect(messageOf(error)); publish(); } }
    },
    dispose() { disposed = true; unsubscribe?.(); listeners.clear(); document.removeEventListener('visibilitychange', onVisibility); },
  };
}
type Controller = ReturnType<typeof stateController>;
export interface AppHandle { ready: Promise<void>; dispose(): void; }
export function createApp(root: HTMLElement, platform: Platform, assetsPromise: Promise<SpriteAssets> = loadSpriteAssets()): AppHandle {
  const controller = stateController(platform); const reactRoot = createRoot(root); let disposed = false;
  flushSync(() => reactRoot.render(<Companion platform={platform} controller={controller} assetsPromise={assetsPromise} />));
  return { ready: controller.start(), dispose() { if (disposed) return; disposed = true; controller.dispose(); flushSync(() => reactRoot.unmount()); } };
}
function Hint({ text, children }: { text: string; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent className="pixel-tooltip" sideOffset={8}>{text}</TooltipContent></Tooltip>;
}
interface SpriteSlot { canvas: HTMLCanvasElement; item: HTMLLIElement; agent: Agent; visible: boolean; stamp: string; }
/** React owns membership; a single imperative clock paints pixels without React state/frame updates. */
function useSpriteClock(agents: Agent[], assets: SpriteAssets | undefined, scale: 1 | 2, paused: boolean, suspended: boolean, workspace: React.RefObject<HTMLElement | null>) {
  const slots = useRef(new Map<string, SpriteSlot>());
  const agentData = useRef(new Map<string, Agent>()); agentData.current = new Map(agents.map(agent => [agent.key, agent]));
  const callbacks = useRef(new Map<string, (item: HTMLLIElement | null) => void>());
  const current = useRef({ assets, scale, paused, suspended }); current.current = { assets, scale, paused, suspended };
  const clock = useRef<RenderScheduler | null>(null);
  if (!clock.current) clock.current = new RenderScheduler(elapsed => {
    const { assets, scale, paused, suspended } = current.current; if (!assets || suspended || document.hidden) return;
    for (const slot of slots.current.values()) {
      if (!slot.visible || slot.canvas.hidden) continue;
      const frame = frameAt(slot.agent.state, elapsed, paused); const stamp = `${scale}:${paused}:${slot.agent.key}:${frame.row}:${frame.column}`;
      if (stamp !== slot.stamp) { drawSprite(slot.canvas, assets, slot.agent.key, slot.agent.state, elapsed, scale, paused); slot.stamp = stamp; }
    }
  });
  const intersection = useRef<IntersectionObserver | null>(null);
  const update = () => {
    const scheduler = clock.current!; scheduler.stop(); scheduler.paint();
    if (current.current.assets && !current.current.paused && !current.current.suspended && !document.hidden && [...slots.current.values()].some(slot => slot.visible && !slot.canvas.hidden && animationForState(slot.agent.state).fps)) scheduler.start();
  };
  useLayoutEffect(() => {
    if (typeof IntersectionObserver !== 'undefined') intersection.current = new IntersectionObserver(entries => {
      for (const entry of entries) { const slot = slots.current.get((entry.target as HTMLElement).dataset.key!); if (slot) slot.visible = entry.isIntersecting; } update();
    }, { root: workspace.current });
    for (const slot of slots.current.values()) intersection.current?.observe(slot.item);
    const onVisibility = () => update(); document.addEventListener('visibilitychange', onVisibility);
    return () => { intersection.current?.disconnect(); intersection.current = null; clock.current?.dispose(); document.removeEventListener('visibilitychange', onVisibility); slots.current.clear(); };
  }, []);
  useLayoutEffect(() => {
    for (const [key, slot] of slots.current) { const agent = agentData.current.get(key); if (agent) { if (slot.agent.state !== agent.state) slot.stamp = ''; slot.agent = agent; } }
    for (const key of callbacks.current.keys()) if (!agentData.current.has(key)) callbacks.current.delete(key);
    update();
  }, [agents, assets, scale, paused, suspended]);
  return (agent: Agent) => {
    if (!callbacks.current.has(agent.key)) callbacks.current.set(agent.key, item => {
      const previous = slots.current.get(agent.key);
      if (!item) { if (previous) intersection.current?.unobserve(previous.item); slots.current.delete(agent.key); return; }
      const canvas = item.querySelector('canvas')!;
      slots.current.set(agent.key, { canvas, item, agent: agentData.current.get(agent.key) || agent, visible: previous?.visible ?? typeof IntersectionObserver === 'undefined', stamp: '' });
      if (!previous) intersection.current?.observe(item);
    });
    return callbacks.current.get(agent.key)!;
  };
}
function Companion({ platform, controller, assetsPromise }: { platform: Platform; controller: Controller; assetsPromise: Promise<SpriteAssets> }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  const mode = state.window.mode || 'office'; const taskbar = mode === 'taskbar';
  const agents = useMemo(() => liveAgents(state), [state]); const groups = useMemo(() => groupWorkspaces(agents), [agents]);
  const [filter, setFilter] = useState(''); const validFilter = reconcileWorkspaceSelection(groups, filter);
  const group = groups.find(group => group.key === validFilter); const visible = group?.agents || agents;
  // A refresh/disconnect hides the live roster but cannot prove a workspace vanished.
  useEffect(() => { if (state.bridge.status === 'listening' && filter !== validFilter) setFilter(validFilter); }, [filter, validFilter, state.bridge.status]);
  const [scale, setScale] = useState<1 | 2>(1); const [size, setSize] = useState('compact');
  // The strip is always native 1×. Returning to Office restores its own choice.
  const spriteScale = taskbar ? 1 : scale;
  const [motionPaused, setMotionPaused] = useState(false); const [menuOpen, setMenuOpen] = useState(false); const [guideOpen, setGuideOpen] = useState(false);
  const [selected, setSelected] = useState(''); const selectedAgent = visible.find(agent => agent.key === selected);
  const [feedback, setFeedback] = useState(''); const [pending, setPending] = useState(false); const pendingRef = useRef(false);
  const [assets, setAssets] = useState<SpriteAssets>(); const [artError, setArtError] = useState(false);
  const media = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)'), []); const [reduced, setReduced] = useState(media.matches);
  const menuRef = useRef<HTMLButtonElement>(null); const stripReturn = useRef<HTMLButtonElement>(null); const menuContent = useRef<HTMLDivElement>(null); const focusedWorkspace = useRef(''); const detailTitle = useRef<HTMLHeadingElement>(null); const detail = useRef<HTMLElement>(null); const office = useRef<HTMLElement>(null); const entry = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true); const focusedAgent = useRef('');
  const registerSprite = useSpriteClock(visible, assets, spriteScale, motionPaused || reduced, state.window.fullscreenHidden === true, office);
  useLayoutEffect(() => {
    const previous = document.documentElement.dataset.windowMode;
    document.documentElement.dataset.windowMode = mode;
    return () => { if (previous === undefined) delete document.documentElement.dataset.windowMode; else document.documentElement.dataset.windowMode = previous; };
  }, [mode]);
  const previousMode = useRef(mode); const modeFocusPending = useRef(false);
  useLayoutEffect(() => {
    if (previousMode.current === mode) return;
    previousMode.current = mode;
    // Native tray/recovery can change modes while a portal owns keyboard focus.
    setMenuOpen(false); setGuideOpen(false); setSelected('');
    modeFocusPending.current = true;
  }, [mode, taskbar]);
  useLayoutEffect(() => {
    const target = taskbar ? stripReturn.current : menuRef.current;
    // Command results arrive before their busy state clears. Disabled buttons
    // cannot receive focus, so complete recovery after the command settles.
    if (modeFocusPending.current && target && !target.disabled) {
      target.focus({ preventScroll: true }); modeFocusPending.current = false;
    }
  }, [mode, pending, taskbar]);
  useEffect(() => { const listener = () => setReduced(media.matches); media.addEventListener('change', listener); return () => media.removeEventListener('change', listener); }, [media]);
  useEffect(() => { let active = true; void assetsPromise.then(value => { if (active) setAssets(value); }).catch(() => { if (active) setArtError(true); }); return () => { active = false; }; }, [assetsPromise]);
  useEffect(() => () => { alive.current = false; }, []);
  useLayoutEffect(() => {
    if (selected && !selectedAgent) { const lostFocus = detail.current?.contains(document.activeElement); setSelected(''); if (lostFocus) focusFirst(); }
    if (focusedAgent.current && !visible.some(agent => agent.key === focusedAgent.current)) { focusedAgent.current = ''; focusFirst(); }
    else if (focusedAgent.current && document.activeElement === document.body) focusAgent(focusedAgent.current);
  }, [visible, selected, selectedAgent]);
  useLayoutEffect(() => {
    if (menuOpen && focusedWorkspace.current && !groups.some(workspace => workspace.key === focusedWorkspace.current)) {
      focusedWorkspace.current = '';
      (menuContent.current?.querySelector<HTMLElement>('[role="menuitemradio"]') || menuRef.current)?.focus();
    }
  }, [groups, menuOpen]);
  function focusAgent(key: string) { const target = [...(office.current?.querySelectorAll<HTMLButtonElement>('.agent-button') || [])].find(node => node.dataset.agentKey === key); (target || stripReturn.current || menuRef.current)?.focus({ preventScroll: true }); }
  function focusFirst() { (office.current?.querySelector<HTMLButtonElement>('.agent-button') || stripReturn.current || menuRef.current)?.focus({ preventScroll: true }); }
  function closeDetails() { const old = selected; setSelected(''); focusAgent(old); }
  async function selectAgent(agent: Agent) {
    if (taskbar) {
      if (!await changeMode('office') || controller.snapshot().window.mode === 'taskbar') return;
      // A mode command can finish after a disconnect or a newer native recovery event.
      if (!alive.current || !liveAgents(controller.snapshot()).some(current => current.key === agent.key)) return;
    }
    if (selected === agent.key) closeDetails(); else setSelected(agent.key);
  }
  useLayoutEffect(() => { if (selectedAgent) detailTitle.current?.focus({ preventScroll: true }); }, [selected]);
  async function run(command: WindowCommand): Promise<boolean> {
    if (pendingRef.current) return false; pendingRef.current = true; setPending(true); setFeedback('');
    try {
      const result = await platform.command(command); if (!alive.current) return false;
      if (result !== undefined && result !== null) controller.receive(result);
      else if (command.name !== 'hide_window' && command.name !== 'start_dragging') controller.receive(await platform.getState());
      return true;
    } catch (error) { if (alive.current) setFeedback(messageOf(error)); return false; }
    finally { pendingRef.current = false; if (alive.current) setPending(false); }
  }
  async function changeMode(next: WindowMode): Promise<boolean> {
    if (next === 'taskbar' && state.window.recoveryAvailable !== true) return false;
    setMenuOpen(false); setGuideOpen(false);
    return run({ name: 'set_window_mode', args: { mode: next } });
  }
  const commandFeedback = feedback || (state.window.clickThrough ? 'Pass-through is on. Use the tray or recovery shortcut to restore interaction.' : '');
  const recovery = state.window.recoveryAvailable === true;
  const bridgeLabel = { starting: 'Starting', listening: platform.review ? 'Sample office' : agents.length ? 'Live' : 'Listening', error: 'Connection unavailable', stopped: 'Stopped' }[state.bridge.status];
  const warning = !recovery ? 'Window recovery is unavailable. Taskbar mode, hide and pass-through are disabled so you can keep control of the companion.' : state.bridge.message || '';
  const artworkCapped = visible.length > ILLUSTRATED_LIMIT; const omitted = state.bridge.status === 'listening' ? state.snapshot.omittedAgentCount || 0 : 0;
  const config = state.bridge.observerEntry ? JSON.stringify({ extensions: [state.bridge.observerEntry] }, null, 2) : '';
  const showGuide = () => { setMenuOpen(false); setGuideOpen(true); };
  const pauseLabel = reduced ? 'Reduced motion' : motionPaused ? 'Resume motion' : 'Pause motion';
  const stripNotice = commandFeedback || warning || (artError ? 'Artwork unavailable. Live names and status are still shown.' : omitted ? `Roster incomplete: ${omitted} additional agents omitted by the bridge.` : artworkCapped ? `First ${ILLUSTRATED_LIMIT} desks illustrated; all ${visible.length} agents are listed.` : '');
  return <TooltipProvider delayDuration={500}><main className="companion" data-scale={spriteScale} data-mode={mode} aria-label={taskbar ? 'Pi companion taskbar' : 'Pi companion'} onKeyDown={event => { if (event.key === 'Escape' && !menuOpen && !guideOpen && selected) { event.preventDefault(); closeDetails(); } }}>
    {taskbar && <aside className="strip-controls" aria-label="Taskbar controls">
      {platform.review && <span className="strip-review">SAMPLE</span>}
      {stripNotice && <div className="strip-notice" role="status">{stripNotice}</div>}
      <span className="strip-project" title={group?.cwd || group?.name || 'Every connected workspace'}>{group?.name || 'All projects'}</span>
      <span className="strip-count sr-only">{visible.length} {visible.length === 1 ? 'agent' : 'agents'}</span>
      <Button ref={stripReturn} className="strip-return" disabled={pending} aria-label="Return to Office for options and details" onClick={() => void changeMode('office')}>Office</Button>
    </aside>}
    {!taskbar && <header className="titlebar" onPointerDown={event => { if (event.button === 0 && !(event.target as HTMLElement).closest('button,[role="menu"],a,input,textarea')) void platform.command({ name: 'start_dragging' }).catch(() => {}); }}>
      <div className="brand"><span className="brand-mark" aria-hidden="true">π</span><h1>companion</h1><span className="edition">PIXEL OFFICE</span></div>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild><Button ref={menuRef} className="menu-button" aria-label="Office options">Menu</Button></DropdownMenuTrigger>
        <DropdownMenuContent ref={menuContent} className="office-menu" align="end" sideOffset={8} collisionPadding={8}>
          <DropdownMenuLabel>Office options</DropdownMenuLabel>
          <DropdownMenuLabel className="field-label">Project / workspace</DropdownMenuLabel>
          <DropdownMenuRadioGroup className="project-options" aria-label="Project or workspace" value={validFilter || '__all__'} onValueChange={value => setFilter(value === '__all__' ? '' : value)}>
            <DropdownMenuRadioItem value="__all__" onSelect={event => event.preventDefault()}>All projects <span className="option-detail">{groups.length} workspaces · {agents.length} agents</span></DropdownMenuRadioItem>
            {groups.map(workspace => <DropdownMenuRadioItem key={workspace.key} value={workspace.key} onFocus={() => { focusedWorkspace.current = workspace.key; }} onBlur={event => { if (event.relatedTarget) focusedWorkspace.current = ''; }} onSelect={event => event.preventDefault()}><span className="option-label">{workspace.label}</span><span className="option-detail">{workspace.cwd || 'Workspace not shared'}<br />{workspace.agents.length} agents · {workspace.sessionIds.length} sessions</span></DropdownMenuRadioItem>)}
          </DropdownMenuRadioGroup>
          <DropdownMenuLabel className="field-label">Window mode</DropdownMenuLabel><DropdownMenuRadioGroup className="menu-choice-row" aria-label="Window mode" value={mode} onValueChange={value => { void changeMode(value as WindowMode); }}><DropdownMenuRadioItem value="office" disabled={pending} onSelect={event => event.preventDefault()}>Office</DropdownMenuRadioItem><DropdownMenuRadioItem value="taskbar" disabled={pending || !recovery} onSelect={event => event.preventDefault()}>Taskbar</DropdownMenuRadioItem></DropdownMenuRadioGroup>
          <DropdownMenuLabel className="field-label">Artwork scale</DropdownMenuLabel><DropdownMenuRadioGroup className="menu-choice-row" aria-label="Artwork scale" value={String(scale)} onValueChange={value => setScale(value === '1' ? 1 : 2)}><DropdownMenuRadioItem value="1" onSelect={event => event.preventDefault()}>1× · small</DropdownMenuRadioItem><DropdownMenuRadioItem value="2" onSelect={event => event.preventDefault()}>2× · original</DropdownMenuRadioItem></DropdownMenuRadioGroup>
          <DropdownMenuLabel className="field-label">Window size</DropdownMenuLabel><DropdownMenuRadioGroup className="menu-choice-row" aria-label="Window size" value={size} onValueChange={value => { void run({ name: 'resize_window', args: { preset: value as 'compact' | 'wide' | 'tall' } }).then(ok => { if (ok && alive.current) setSize(value); }); }}>{['compact', 'wide', 'tall'].map(value => <DropdownMenuRadioItem key={value} value={value} disabled={pending} onSelect={event => event.preventDefault()}>{value[0].toUpperCase() + value.slice(1)}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem checked={state.window.pinned} disabled={pending} onCheckedChange={() => void run({ name: 'set_pinned', args: { pinned: !state.window.pinned } })}>{state.window.pinned ? 'Pinned' : 'Pin'}</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={state.window.clickThrough} disabled={pending || !recovery} onCheckedChange={() => { setMenuOpen(false); void run({ name: 'set_click_through', args: { enabled: !state.window.clickThrough } }); }}>Pass through</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={motionPaused || reduced} disabled={reduced} onCheckedChange={() => setMotionPaused(!motionPaused)}>{pauseLabel}</DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={pending || !recovery} onSelect={() => { setMenuOpen(false); void run({ name: 'hide_window' }); }}>Hide</DropdownMenuItem>
          <DropdownMenuItem onSelect={showGuide}>{agents.length ? 'Connection guide' : 'Connect Pi'}</DropdownMenuItem>
          <div className="menu-note">Restore from tray or Ctrl+Shift+P.</div>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>}
    {!taskbar && platform.review && <div className="review-banner">DESIGN REVIEW · Sample agents, no live Pi connection</div>}
    {!taskbar && <div className="summary"><span className="connection" data-status={state.bridge.status}>{bridgeLabel}</span><Hint text={group?.cwd || (group ? 'Workspace not shared' : 'Every connected workspace')}><span className="current-project" tabIndex={0}>{group?.name || 'All projects'}</span></Hint><span className="agent-count">{visible.length}{validFilter ? ` of ${agents.length}` : ''} {visible.length === 1 ? 'agent' : 'agents'}</span></div>}
    {!taskbar && warning && <p className="warning">{warning}</p>}
    <section className="workspace" aria-label={taskbar ? 'Agent taskbar. Scroll horizontally for more desks' : 'Agent office'} ref={office} tabIndex={taskbar ? 0 : undefined}>
      {!taskbar && artError && <p className="art-warning">Bundled artwork could not be loaded. Agent names and live status remain available.</p>}
      {!visible.length && <div className="empty-state"><div className="empty-mark" aria-hidden="true">π</div><h2>{state.bridge.status === 'listening' ? taskbar ? 'No connected agents' : 'A little room for your next idea' : state.bridge.status === 'starting' ? 'Opening the office…' : 'Waiting for a live connection'}</h2><p>{state.bridge.status === 'listening' ? 'Your connected Pi sessions will settle in here. An idle session stays until it disconnects.' : state.bridge.status === 'starting' ? 'The desktop companion is starting its local observer.' : 'No agents are shown while the connection is unavailable.'}</p>{!taskbar && <Button className="primary-button" onClick={showGuide}>Connection guide</Button>}</div>}
      {(artworkCapped || omitted > 0) && <p className={taskbar ? 'capacity sr-only' : 'capacity'}>{artworkCapped ? `Artwork is limited to ${ILLUSTRATED_LIMIT} agents. The remaining ${visible.length - ILLUSTRATED_LIMIT} remain in accessible text entries. ` : ''}{omitted ? `The local bridge omitted ${omitted} additional ${omitted === 1 ? 'agent' : 'agents'} because its safety limit was reached. This roster is incomplete.` : ''}</p>}
      <ul className="roster" aria-label="Active agents" data-view={mode} hidden={!visible.length}>{visible.map((agent, index) => <li className={`agent${index >= ILLUSTRATED_LIMIT || artError ? ' text-only' : ''}`} data-key={agent.key} key={agent.key} ref={registerSprite(agent)}>
        <button type="button" className="agent-button" data-agent-key={agent.key} aria-label={`${agent.name}, ${statusLabel(agent)}, ${agent.sessionName || 'Unnamed session'}. ${taskbar ? 'Open Office and view details' : 'View details'}`} aria-pressed={!taskbar && agent.key === selected} onClick={() => void selectAgent(agent)} onFocus={() => { focusedAgent.current = agent.key; }} onBlur={event => { if (event.relatedTarget) focusedAgent.current = ''; }}>
          <span className="status-bubble" data-state={agent.state}>{taskbar ? <span className="taskbar-bubble-body">{STATE_LABELS[agent.state]}</span> : statusLabel(agent)}</span><canvas className="portrait" width={spriteScale * 64} height={spriteScale * 64} aria-hidden="true" hidden={index >= ILLUSTRATED_LIMIT || artError} />
          {!taskbar && <span className="agent-copy"><span className="agent-name">{agent.name}</span></span>}
          {taskbar && <span className="strip-agent-name" aria-hidden="true">{agent.name}</span>}
        </button>
      </li>)}</ul>
    </section>
    <section className="detail" ref={detail} hidden={taskbar || !selectedAgent} aria-labelledby="detail-title"><div className="detail-head"><h2 id="detail-title" ref={detailTitle} tabIndex={-1}>{selectedAgent?.name || 'Agent details'}</h2><Button className="quiet-button" onClick={closeDetails}>Close details</Button></div><p className="detail-status">{selectedAgent && statusLabel(selectedAgent)}</p><p className="detail-task">{selectedAgent?.task || 'No task description shared.'}</p><dl className="detail-fields">{selectedAgent && [['Workspace', selectedAgent.cwd], ['Session', selectedAgent.sessionName || selectedAgent.sessionId], ['Role', selectedAgent.role], ['Tool', selectedAgent.tool], ['Model', selectedAgent.model]].filter(([, value]) => value).map(([label, value]) => <div className="detail-field" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
    {!taskbar && commandFeedback && <div className="command-feedback" role="status">{commandFeedback}</div>}
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{bridgeLabel}. {agents.length} {agents.length === 1 ? 'agent' : 'agents'} connected. {agents.filter(agent => agent.state === 'waiting' || agent.state === 'error').length} need attention.</div>
    <Dialog open={!taskbar && guideOpen} onOpenChange={setGuideOpen}><DialogContent className="guide" onCloseAutoFocus={event => { event.preventDefault(); (stripReturn.current || menuRef.current)?.focus(); }}><DialogHeader><DialogTitle>Bring your Pi sessions in</DialogTitle><DialogDescription>Add the observer to your Pi settings once. After that, ordinary Pi launches connect automatically while the companion is running.</DialogDescription></DialogHeader>
      <ol><li>Open your Pi user settings (normally ~/.pi/agent/settings.json). Add the path below to the existing extensions array; keep your other settings and extensions.</li><li>When Pi is idle, run /reload once in each already-open session, or start Pi normally. If replacing Pi Office, remove its old observer entry to avoid loading both.</li><li>Keep the companion running. It reconnects automatically after an app restart; no environment variable or special launch command is needed.</li></ol>
      <label className="path-label" htmlFor="observer-settings-entry">PI SETTINGS EXAMPLE</label><textarea ref={entry} id="observer-settings-entry" className="connection-path" aria-label="Pi settings entry" readOnly rows={5} spellCheck={false} value={config} placeholder={platform.review ? 'The running desktop app shows your stable observer entry here.' : 'The observer entry will appear after the desktop app prepares it.'} />
      <Button className="quiet-button" disabled={!config} onClick={() => { entry.current?.focus(); entry.current?.select(); }}>Select config entry</Button><p className="guide-note">Select the example, then copy with Ctrl+C (Cmd+C on macOS). Merge the path into your existing extensions array rather than replacing your settings file.</p><p className="guide-note">The observer finds its private connection file automatically. The companion does not change your Pi settings or expose the credential. Remove this extension entry to stop loading the observer.</p><DialogFooter><Button className="primary-button" onClick={() => setGuideOpen(false)}>Got it</Button></DialogFooter>
    </DialogContent></Dialog>
  </main></TooltipProvider>;
}
