import type { Agent } from './model';
import { liveAgents, StateStore, statusLabel } from './model';
import type { Platform, WindowCommand } from './platform';
import { RenderScheduler } from './scheduler';
import { animationForState, drawSprite, frameAt, ILLUSTRATED_LIMIT, loadSpriteAssets } from './sprites';
import type { SpriteAssets } from './sprites';

type View = 'office' | 'list';
interface Card { item: HTMLLIElement; button: HTMLButtonElement; canvas: HTMLCanvasElement; name: HTMLElement; session: HTMLElement; status: HTMLElement; agent: Agent; drawn: string; visible: boolean; }
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const button = (label: string, className = '') => { const node = el('button', className, label); node.type = 'button'; return node; };
const option = (label: string, value: string) => { const node = el('option', '', label); node.value = value; return node; };
const labeledSelect = (label: string, select: HTMLSelectElement) => { const node = el('label', 'select-label'); node.append(el('span', '', label), select); return node; };
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'The desktop command could not be completed. Try again from the tray.';

export interface AppHandle { ready: Promise<void>; dispose(): void; }
export function createApp(root: HTMLElement, platform: Platform, assetsPromise: Promise<SpriteAssets> = loadSpriteAssets()): AppHandle {
  const store = new StateStore();
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let assets: SpriteAssets | undefined;
  let artError = false;
  let view: View = 'office';
  let scale: 1 | 2 = 2;
  let filter = '';
  let selected = '';
  let motionPaused = false;
  let pending = false;
  let announcement = '';
  let acceptedUpdates = 0;
  let refreshRequest = 0;
  const cards = new Map<string, Card>();
  const media = window.matchMedia('(prefers-reduced-motion: reduce)');
  const shell = el('main', 'companion');
  shell.setAttribute('aria-label', 'Pi companion');
  shell.dataset.scale = String(scale);
  const header = el('header', 'titlebar');
  const brand = el('div', 'brand');
  brand.append(el('span', 'brand-mark', 'π'), el('h1', '', 'companion'), el('span', 'edition', 'PIXEL OFFICE'));
  const windowActions = el('div', 'window-actions');
  const pin = button('Pin', 'quiet-button'); pin.setAttribute('aria-pressed', 'false'); pin.title = 'Keep the companion above other windows';
  const through = button('Pass through', 'quiet-button'); through.setAttribute('aria-pressed', 'false'); through.title = 'Let clicks reach the window underneath. Restore interaction from the tray or recovery shortcut.';
  const hide = button('Hide', 'quiet-button'); hide.title = 'Hide to the tray';
  windowActions.append(pin, through, hide); header.append(brand, windowActions);
  const reviewBanner = el('div', 'review-banner', 'DESIGN REVIEW · Sample agents, no live Pi connection'); reviewBanner.hidden = !platform.review;
  const toolbar = el('div', 'toolbar');
  const scope = el('select', 'project-select'); scope.setAttribute('aria-label', 'Filter by session'); scope.append(option('All sessions', ''));
  const viewGroup = el('div', 'segmented'); viewGroup.setAttribute('role', 'group'); viewGroup.setAttribute('aria-label', 'Roster view');
  const office = button('Office'); const list = button('List'); viewGroup.append(office, list);
  const scaleSelect = el('select'); scaleSelect.setAttribute('aria-label', 'Artwork scale'); scaleSelect.append(option('1×', '1'), option('2×', '2')); scaleSelect.value = '2';
  toolbar.append(labeledSelect('Session', scope), viewGroup, labeledSelect('Scale', scaleSelect));
  const summary = el('div', 'summary');
  const connection = el('span', 'connection');
  const count = el('span', 'agent-count');
  const help = button('Connect Pi', 'text-button');
  summary.append(connection, count, help);
  const warning = el('p', 'warning'); warning.hidden = true;
  const workspace = el('section', 'workspace'); workspace.setAttribute('aria-label', 'Agent office');
  const empty = el('div', 'empty-state');
  const emptyMark = el('div', 'empty-mark', 'π'); emptyMark.setAttribute('aria-hidden', 'true');
  const emptyTitle = el('h2'); const emptyText = el('p'); const emptyHelp = button('Connection guide', 'primary-button');
  empty.append(emptyMark, emptyTitle, emptyText, emptyHelp);
  const artWarning = el('p', 'art-warning', 'Bundled artwork could not be loaded. Agent names and live status remain available.'); artWarning.hidden = true;
  const capacity = el('p', 'capacity'); capacity.hidden = true;
  const roster = el('ul', 'roster'); roster.setAttribute('aria-label', 'Active agents'); roster.dataset.view = view;
  workspace.append(artWarning, empty, capacity, roster);
  const detail = el('section', 'detail'); detail.hidden = true; detail.setAttribute('aria-labelledby', 'detail-title');
  const detailHead = el('div', 'detail-head'); const detailTitle = el('h2', '', 'Agent details'); detailTitle.id = 'detail-title'; detailTitle.tabIndex = -1;
  const closeDetail = button('Close details', 'quiet-button'); detailHead.append(detailTitle, closeDetail);
  const detailStatus = el('p', 'detail-status'); const detailTask = el('p', 'detail-task'); const detailFields = el('dl', 'detail-fields');
  detail.append(detailHead, detailStatus, detailTask, detailFields);
  const footer = el('footer', 'footer');
  const footnote = el('span', 'footnote', 'Only connected Pi sessions appear');
  const motion = button('Pause motion', 'text-button'); motion.setAttribute('aria-pressed', 'false');
  const size = el('select', 'size-select'); size.setAttribute('aria-label', 'Window size'); size.append(option('Compact', 'compact'), option('Wide', 'wide'), option('Tall', 'tall'));
  footer.append(footnote, motion, size);
  const live = el('div', 'sr-only'); live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true');
  const feedback = el('div', 'command-feedback'); feedback.setAttribute('role', 'status'); feedback.hidden = true;
  const guide = el('dialog', 'guide'); guide.setAttribute('aria-labelledby', 'guide-title');
  const guideTitle = el('h2', '', 'Bring your Pi sessions in'); guideTitle.id = 'guide-title';
  const guideLead = el('p', '', 'Add the observer to your Pi settings once. After that, ordinary Pi launches connect automatically while the companion is running.');
  const guideSteps = el('ol');
  for (const text of ['Open your Pi user settings (normally ~/.pi/agent/settings.json). Add the path below to the existing extensions array; keep your other settings and extensions.', 'When Pi is idle, run /reload once in each already-open session, or start Pi normally. If replacing Pi Office, remove its old observer entry to avoid loading both.', 'Keep the companion running. It reconnects automatically after an app restart; no environment variable or special launch command is needed.']) guideSteps.append(el('li', '', text));
  const observerLabel = el('label', 'path-label', 'PI SETTINGS EXAMPLE'); observerLabel.htmlFor = 'observer-settings-entry';
  const observerEntry = el('textarea', 'connection-path'); observerEntry.id = 'observer-settings-entry'; observerEntry.readOnly = true; observerEntry.rows = 5; observerEntry.spellcheck = false; observerEntry.setAttribute('aria-label', 'Pi settings entry');
  const selectEntry = button('Select config entry', 'quiet-button'); selectEntry.disabled = true;
  const selectHint = el('p', 'guide-note', 'Select the example, then copy with Ctrl+C (Cmd+C on macOS). Merge the path into your existing extensions array rather than replacing your settings file.');
  const guideNote = el('p', 'guide-note', 'The observer finds its private connection file automatically. The companion does not change your Pi settings or expose the credential. Remove this extension entry to stop loading the observer.');
  const closeGuide = button('Got it', 'primary-button'); guide.append(guideTitle, guideLead, guideSteps, observerLabel, observerEntry, selectEntry, selectHint, guideNote, closeGuide);
  shell.append(header, reviewBanner, toolbar, summary, warning, workspace, detail, feedback, footer, live, guide); root.replaceChildren(shell);

  const scheduler = new RenderScheduler(elapsed => {
    if (!assets || document.hidden || view !== 'office') return;
    for (const card of cards.values()) {
      if (!card.visible || card.canvas.hidden) continue;
      const frame = frameAt(card.agent.state, elapsed, media.matches || motionPaused);
      const stamp = `${scale}:${frame.row}:${frame.column}:${card.agent.key}`;
      if (stamp !== card.drawn) { drawSprite(card.canvas, assets, card.agent.key, card.agent.state, elapsed, scale, media.matches || motionPaused); card.drawn = stamp; }
    }
  });
  const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
    for (const entry of entries) { const card = cards.get((entry.target as HTMLElement).dataset.key!); if (card) card.visible = entry.isIntersecting; }
    updateMotion();
  }, { root: workspace });
  function announce(text: string): void { if (text !== announcement) { live.textContent = text; announcement = text; } }
  function updateMotion(): void {
    if (disposed) { scheduler.stop(); return; }
    const paused = motionPaused || media.matches;
    motion.textContent = media.matches ? 'Reduced motion' : motionPaused ? 'Resume motion' : 'Pause motion';
    motion.disabled = media.matches; motion.setAttribute('aria-pressed', String(paused));
    scheduler.stop(); scheduler.paint();
    if (assets && !paused && !document.hidden && view === 'office' && liveAgents(store.current).length && [...cards.values()].some(card => card.visible && !card.canvas.hidden && animationForState(card.agent.state).fps)) scheduler.start();
  }
  function showGuide(): void {
    if (!guide.open) { if (typeof guide.showModal === 'function') guide.showModal(); else guide.setAttribute('open', ''); }
  }
  function closeDetails(focus = true): void {
    const previous = selected; selected = ''; detail.hidden = true;
    for (const card of cards.values()) card.button.setAttribute('aria-pressed', 'false');
    if (focus) cards.get(previous)?.button.focus();
  }
  function updateDetails(agent: Agent): void {
    detail.hidden = false; detailTitle.textContent = agent.name; detailStatus.textContent = statusLabel(agent);
    detailTask.textContent = agent.task || 'No task description shared.';
    detailFields.replaceChildren();
    for (const [label, value] of [['Session', agent.sessionName || agent.sessionId], ['Role', agent.role], ['Tool', agent.tool], ['Model', agent.model]]) {
      if (value) detailFields.append(el('dt', '', label), el('dd', '', value));
    }
  }
  function selectAgent(key: string): void {
    const agent = liveAgents(store.current).find(item => item.key === key); if (!agent) return;
    if (selected === key) { closeDetails(); return; }
    selected = key; updateDetails(agent);
    for (const card of cards.values()) card.button.setAttribute('aria-pressed', String(card.agent.key === key));
    detailTitle.focus({ preventScroll: true });
  }
  function makeCard(agent: Agent): Card {
    const item = el('li', 'agent'); item.dataset.key = agent.key;
    const choose = button('', 'agent-button');
    const bubble = el('span', 'status-bubble'); const canvas = el('canvas', 'portrait'); canvas.width = 128; canvas.height = 128; canvas.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'agent-copy'); const name = el('span', 'agent-name'); const session = el('span', 'agent-session'); copy.append(name, session);
    choose.append(bubble, canvas, copy); choose.addEventListener('click', () => selectAgent(agent.key)); item.append(choose);
    const card: Card = { item, button: choose, canvas, name, session, status: bubble, agent, drawn: '', visible: !observer };
    cards.set(agent.key, card); observer?.observe(item); return card;
  }
  function render(): void {
    const state = store.current;
    const agents = liveAgents(state);
    const sessions = new Map(agents.map(agent => [agent.sessionId, agent.sessionName || agent.sessionId]));
    if (filter && !sessions.has(filter)) filter = '';
    const expectedOptions = JSON.stringify([...sessions]);
    if (scope.dataset.options !== expectedOptions) {
      scope.replaceChildren(option('All sessions', ''), ...[...sessions].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => option(name, id)));
      scope.dataset.options = expectedOptions;
    }
    scope.value = filter;
    const visible = agents.filter(agent => !filter || agent.sessionId === filter);
    const recovery = state.window.recoveryAvailable === true;
    pin.setAttribute('aria-pressed', String(state.window.pinned)); pin.textContent = state.window.pinned ? 'Pinned' : 'Pin';
    through.setAttribute('aria-pressed', String(state.window.clickThrough));
    through.disabled = pending || !recovery; hide.disabled = pending || !recovery; pin.disabled = pending; size.disabled = pending;
    through.title = recovery ? 'Let clicks reach the window underneath. Use the tray or recovery shortcut to restore interaction.' : 'Unavailable because the tray and recovery shortcut are not ready.';
    hide.title = recovery ? 'Hide to the tray' : 'Unavailable until a recovery route is ready';
    const bridgeLabel = { starting: 'Starting', listening: platform.review ? 'Sample office' : 'Listening locally', error: 'Connection unavailable', stopped: 'Companion stopped' }[state.bridge.status];
    connection.textContent = bridgeLabel; connection.dataset.status = state.bridge.status;
    count.textContent = `${visible.length}${filter ? ` of ${agents.length}` : ''} ${visible.length === 1 ? 'agent' : 'agents'}`;
    help.textContent = agents.length ? 'Connection guide' : 'Connect Pi';
    warning.hidden = recovery && !state.bridge.message;
    warning.textContent = !recovery ? 'Window recovery is unavailable. Hide and pass-through are disabled so you can keep control of the companion.' : state.bridge.message || '';
    const entry = state.bridge.observerEntry;
    const config = entry ? JSON.stringify({ extensions: [entry] }, null, 2) : '';
    if (observerEntry.value !== config) observerEntry.value = config;
    observerEntry.placeholder = platform.review ? 'The running desktop app shows your stable observer entry here.' : 'The observer entry will appear after the desktop app prepares it.';
    selectEntry.disabled = !entry;
    empty.hidden = visible.length > 0;
    if (!visible.length) {
      emptyTitle.textContent = state.bridge.status === 'listening' ? 'A little room for your next idea' : state.bridge.status === 'starting' ? 'Opening the office…' : 'Waiting for a live connection';
      emptyText.textContent = state.bridge.status === 'listening' ? 'Your connected Pi sessions will settle in here. An idle session stays until it disconnects.' : state.bridge.status === 'starting' ? 'The desktop companion is starting its local observer.' : 'No agents are shown while the connection is unavailable.';
    }
    roster.hidden = !visible.length; roster.dataset.view = view; shell.dataset.scale = String(scale);
    office.setAttribute('aria-pressed', String(view === 'office')); list.setAttribute('aria-pressed', String(view === 'list')); scaleSelect.disabled = view !== 'office';
    const omitted = state.bridge.status === 'listening' ? state.snapshot.omittedAgentCount || 0 : 0;
    const artworkCapped = view === 'office' && visible.length > ILLUSTRATED_LIMIT;
    capacity.hidden = !artworkCapped && !omitted;
    capacity.textContent = [artworkCapped ? `Artwork is limited to ${ILLUSTRATED_LIMIT} agents. The remaining ${visible.length - ILLUSTRATED_LIMIT} are included as text rows. List view includes everyone received.` : '', omitted ? `The local bridge omitted ${omitted} additional ${omitted === 1 ? 'agent' : 'agents'} because its safety limit was reached. This roster is incomplete.` : ''].filter(Boolean).join(' ');
    const needed = new Set(visible.map(agent => agent.key));
    const focusedCard = [...cards.values()].find(card => card.button === document.activeElement);
    const focusedRemoved = focusedCard && !needed.has(focusedCard.agent.key);
    for (const [key, card] of cards) if (!needed.has(key)) { observer?.unobserve(card.item); card.item.remove(); cards.delete(key); }
    visible.forEach((agent, index) => {
      const card = cards.get(agent.key) || makeCard(agent); const previous = card.agent;
      card.agent = agent; if (previous.state !== agent.state) card.drawn = '';
      card.name.textContent = agent.name; card.name.title = agent.name;
      card.session.textContent = agent.sessionName || 'Unnamed session'; card.status.textContent = statusLabel(agent); card.status.title = statusLabel(agent); card.status.dataset.state = agent.state;
      card.button.setAttribute('aria-label', `${agent.name}, ${statusLabel(agent)}, ${agent.sessionName || 'Unnamed session'}. View details`);
      card.button.setAttribute('aria-pressed', String(agent.key === selected));
      card.canvas.hidden = view === 'list' || index >= ILLUSTRATED_LIMIT || artError;
      card.item.classList.toggle('text-only', card.canvas.hidden);
      if (roster.children[index] !== card.item) roster.insertBefore(card.item, roster.children[index] || null);
    });
    // Moving an existing DOM node can blur it even though its identity is stable.
    if (focusedCard && !focusedRemoved && document.activeElement !== focusedCard.button) focusedCard.button.focus({ preventScroll: true });
    if (selected) {
      const agent = visible.find(agent => agent.key === selected);
      if (agent) updateDetails(agent); else { const lostFocus = detail.contains(document.activeElement); closeDetails(false); if (lostFocus) (cards.values().next().value?.button || scope).focus(); }
    }
    if (focusedRemoved) (cards.values().next().value?.button || scope).focus();
    artWarning.hidden = !artError;
    footnote.textContent = platform.review ? 'Synthetic fixture · not a live connection' : filter ? `${sessions.get(filter)} · connected agents only` : `${sessions.size} ${sessions.size === 1 ? 'session' : 'sessions'} · connected agents only`;
    announce(`${bridgeLabel}. ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} connected. ${agents.filter(agent => agent.state === 'waiting' || agent.state === 'error').length} need attention.`);
    updateMotion();
  }
  function receive(value: unknown): void {
    if (disposed) return;
    const result = store.accept(value);
    if (result === 'accepted') acceptedUpdates++;
    if (result !== 'stale') render();
  }
  async function refreshState(): Promise<void> {
    const request = ++refreshRequest;
    const updatesAtRequest = acceptedUpdates;
    try { receive(await platform.getState()); }
    catch (error) {
      // A late failed read must not erase a newer authoritative event or refresh.
      if (!disposed && request === refreshRequest && acceptedUpdates === updatesAtRequest) {
        store.disconnect(messageOf(error)); render();
      }
    }
  }
  async function run(command: WindowCommand): Promise<void> {
    if (pending) return; pending = true; feedback.hidden = true; render();
    try {
      const result = await platform.command(command);
      if (result !== undefined && result !== null) receive(result);
      else if (command.name !== 'hide_window' && command.name !== 'start_dragging') receive(await platform.getState());
      if (command.name === 'set_click_through' && command.args.enabled) { feedback.textContent = 'Pass-through is on. Use the tray or recovery shortcut to restore interaction.'; feedback.hidden = false; }
    } catch (error) { feedback.textContent = messageOf(error); feedback.hidden = false; }
    finally { pending = false; if (!disposed) render(); }
  }
  pin.addEventListener('click', () => void run({ name: 'set_pinned', args: { pinned: !store.current.window.pinned } }));
  through.addEventListener('click', () => void run({ name: 'set_click_through', args: { enabled: !store.current.window.clickThrough } }));
  hide.addEventListener('click', () => void run({ name: 'hide_window' }));
  header.addEventListener('pointerdown', event => { if (event.button === 0 && !(event.target as HTMLElement).closest('button,select,a,input')) void platform.command({ name: 'start_dragging' }).catch(() => {}); });
  scope.addEventListener('change', () => { filter = scope.value; render(); });
  office.addEventListener('click', () => { view = 'office'; render(); }); list.addEventListener('click', () => { view = 'list'; render(); });
  scaleSelect.addEventListener('change', () => { scale = scaleSelect.value === '1' ? 1 : 2; for (const card of cards.values()) card.drawn = ''; render(); });
  size.addEventListener('change', () => void run({ name: 'resize_window', args: { preset: size.value as 'compact' | 'wide' | 'tall' } }));
  motion.addEventListener('click', () => { motionPaused = !motionPaused; for (const card of cards.values()) card.drawn = ''; updateMotion(); });
  help.addEventListener('click', showGuide); emptyHelp.addEventListener('click', showGuide);
  selectEntry.addEventListener('click', () => { observerEntry.focus(); observerEntry.select(); });
  closeGuide.addEventListener('click', () => { guide.close(); help.focus(); });
  closeDetail.addEventListener('click', () => closeDetails());
  shell.addEventListener('keydown', event => { if (event.key === 'Escape' && !guide.open && selected) { event.preventDefault(); closeDetails(); } });
  const onVisibility = () => {
    if (document.hidden) { updateMotion(); return; }
    // Hidden WebViews may miss or defer events. Do not revive their cached roster
    // while the authoritative restore read is still pending (or never resolves).
    store.disconnect('Refreshing the live connection…'); render();
    void refreshState();
  };
  document.addEventListener('visibilitychange', onVisibility); media.addEventListener('change', updateMotion);
  render();
  void assetsPromise.then(value => { if (!disposed) { assets = value; for (const card of cards.values()) card.drawn = ''; updateMotion(); } }).catch(() => { if (!disposed) { artError = true; render(); } });
  const ready = (async () => {
    try { const cleanup = await platform.subscribe(receive); if (disposed) { cleanup(); return; } unsubscribe = cleanup; await refreshState(); }
    catch (error) { if (!disposed) { store.disconnect(messageOf(error)); render(); } }
  })();
  return { ready, dispose() { disposed = true; unsubscribe?.(); scheduler.dispose(); observer?.disconnect(); document.removeEventListener('visibilitychange', onVisibility); media.removeEventListener('change', updateMotion); root.replaceChildren(); } };
}
