import { describe, expect, it } from 'vitest';
import { liveAgents, parseShellState, StateStore, statusLabel } from '../../src/model';
import { agent, state } from './helpers';

describe('authoritative snapshot boundary', () => {
  it('accepts complete native envelopes without deriving liveness from activity', () => {
    const input = { ...state([agent(0, { task: '', state: 'idle' })]), snapshot: { ...state().snapshot, version: 1, bridgeStatus: 'listening' } };
    expect(parseShellState(input)?.snapshot.agents).toHaveLength(1);
    expect(statusLabel(agent(0, { state: 'working', tool: 'bash' }))).toBe('Using bash');
  });
  it.each([null, [], {}, { ...state(), sequence: -1 }, { ...state(), sequence: Infinity }, { ...state(), bridge: { status: 'connected' } }, { ...state(), window: { pinned: 'yes', clickThrough: false } }])('rejects malformed envelopes %j', input => { expect(parseShellState(input)).toBeNull(); });
  it('rejects duplicate identity, unknown states, and malformed fields', () => {
    expect(parseShellState(state([agent(), agent()]))).toBeNull();
    expect(parseShellState(state([agent(0, { state: 'bogus' as never })]))).toBeNull();
    expect(parseShellState(state([agent(0, { name: 4 as never })]))).toBeNull();
    expect(parseShellState({ ...state(), bridge: { status: Object.create(null) } })).toBeNull();
  });
  it('drops the entire live roster for every non-listening bridge state', () => {
    for (const status of ['starting', 'error', 'stopped'] as const) expect(liveAgents({ ...state(), bridge: { status } })).toEqual([]);
  });
  it('normalizes nullable optional metadata and omits explicitly stale/offline agents', () => {
    const parsed = parseShellState(state([agent(0, { tool: null as never, model: null as never }), agent(1, { state: 'offline' }), agent(2, { state: 'stale' })]))!;
    expect(parsed.snapshot.agents[0].tool).toBeUndefined(); expect(parsed.snapshot.agents[0].model).toBeUndefined(); expect(liveAgents(parsed)).toHaveLength(1);
  });
  it('preserves exact workspace identity, while absent, null, and blank cwd remain unknown', () => {
    for (const cwd of ['/projects/Companion/', 'C:\\work\\Companion', ' /significant spaces ', '🚀'.repeat(2048)]) {
      const parsed = parseShellState(state([agent(0, { cwd })]));
      expect(parsed?.snapshot.agents[0].cwd).toBe(cwd);
    }
    for (const cwd of [undefined, null, '', '   ']) {
      expect(parseShellState(state([agent(0, { cwd: cwd as never })]))?.snapshot.agents[0].cwd).toBeUndefined();
    }
  });
  it('rejects malformed workspace identities instead of truncating or merging them', () => {
    for (const cwd of [42, [], {}, 'x'.repeat(4097), '/repo\nname', '/repo\0name', '/repo\uD800', '/repo\uDFFF']) {
      expect(parseShellState(state([agent(0, { cwd: cwd as never })]))).toBeNull();
    }
  });
  it('copies accepted input and orders updates by shell sequence', () => {
    const store = new StateStore(); const original = state();
    expect(store.accept(original)).toBe('accepted'); original.snapshot.agents[0].name = 'Changed outside';
    expect(store.current.snapshot.agents[0].name).toBe('Agent 0');
    const updated = state([agent(0, { name: 'Latest' })], 3); expect(store.accept(updated)).toBe('accepted');
    expect(store.accept(state([], 2))).toBe('stale'); expect(store.current.snapshot.agents[0].name).toBe('Latest');
    expect(store.accept(updated)).toBe('stale');
  });
  it('accepts same snapshot revision for newer window-state responses', () => {
    const store = new StateStore(); store.accept(state());
    const next = state(); next.sequence = 2; next.window.pinned = true;
    expect(store.accept(next)).toBe('accepted'); expect(store.current.window.pinned).toBe(true);
  });
  it('rejects revision regression on the same stream but permits a fresh stream', () => {
    const store = new StateStore(); store.accept(state([agent()], 10));
    const bad = state([agent()], 11); bad.snapshot.revision = 1;
    expect(store.accept(bad)).toBe('invalid'); expect(liveAgents(store.current)).toEqual([]);
    const restart = state([agent()], 12); restart.snapshot.streamId = 'new-stream'; restart.snapshot.revision = 0;
    expect(store.accept(restart)).toBe('accepted'); expect(liveAgents(store.current)).toHaveLength(1);
  });
  it('fails closed on invalid or lost bridge data and waits for a newer valid snapshot', () => {
    const store = new StateStore(); store.accept(state()); store.accept({ unexpected: true });
    expect(liveAgents(store.current)).toEqual([]); expect(store.accept(state())).toBe('stale');
    expect(store.accept(state([agent()], 2))).toBe('accepted');
    store.disconnect('Transport unavailable'); expect(liveAgents(store.current)).toEqual([]);
  });
});
