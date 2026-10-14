import { describe, expect, it } from 'vitest';
import { liveAgents, StateStore } from '../../src/model';
import { groupWorkspaces, reconcileWorkspaceSelection, workspaceKey } from '../../src/workspaces';
import { agent, state } from './helpers';

describe('workspace projection', () => {
  it('combines complete live rosters across sessions only when their exact cwd matches', () => {
    const agents = [
      agent(0, { cwd: '/projects/companion', name: 'Implement panel' }),
      agent(1, { cwd: '/projects/companion', name: 'Researcher' }),
      agent(0, { key: 'session-b/0', sessionId: 'session-b', sessionName: 'Verify panel', cwd: '/projects/companion', name: 'Verify panel' }),
      agent(1, { key: 'session-b/1', sessionId: 'session-b', cwd: '/projects/companion', name: 'QA' }),
    ];
    const groups = groupWorkspaces(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'companion', label: 'companion', cwd: '/projects/companion', sessionIds: ['session-a', 'session-b'] });
    expect(groups[0].agents).toEqual(agents);
    expect(groups[0].agents[0]).toBe(agents[0]);
    expect(agents.map(item => item.name)).toEqual(['Implement panel', 'Researcher', 'Verify panel', 'QA']);
  });

  it('uses full cwd identity, with readable labels for equal folder names', () => {
    const groups = groupWorkspaces([
      agent(0, { cwd: '/work/client/app' }),
      agent(1, { cwd: '/work/personal/app', sessionId: 'other' }),
    ]);
    expect(groups.map(group => group.name)).toEqual(['app', 'app']);
    expect(groups.map(group => group.label)).toEqual(['app · /work/client/app', 'app · /work/personal/app']);
    expect(new Set(groups.map(group => group.key)).size).toBe(2);
  });

  it('does not normalize case, whitespace, separators, trailing separators, Unicode, or dot segments', () => {
    const paths = ['/repo', '/Repo', '/repo/', '/repo/.', '/repo/../repo', ' /repo', '/repo ', 'C:\\work\\repo', 'C:/work/repo', '/caf\u00e9', '/cafe\u0301'];
    expect(groupWorkspaces(paths.map((cwd, index) => agent(index, { cwd })))).toHaveLength(paths.length);
    expect(new Set(paths.map(cwd => workspaceKey(agent(0, { cwd })))).size).toBe(paths.length);
  });

  it('shows meaningful Windows and root path names without using them as identities', () => {
    const paths = ['C:\\projects\\companion', '\\\\server\\share\\research', '/', 'C:\\'];
    const groups = groupWorkspaces(paths.map((cwd, index) => agent(index, { cwd })));
    expect(groups.find(group => group.cwd === paths[0])?.name).toBe('companion');
    expect(groups.find(group => group.cwd === paths[1])?.name).toBe('research');
    expect(groups.find(group => group.cwd === '/')?.name).toBe('/');
    expect(groups.find(group => group.cwd === 'C:\\')?.name).toBe('C:');
  });

  it('keeps unknown workspaces separate per session while preserving every child', () => {
    const agents = [agent(0), agent(1, { cwd: '' }), agent(2, { cwd: '   ' }), agent(3, { cwd: null as never }), agent(4, { sessionId: 'second', sessionName: 'Different work' })];
    const groups = groupWorkspaces(agents);
    expect(groups).toHaveLength(2);
    expect(groups.find(group => group.sessionIds.includes('session-a'))?.agents).toHaveLength(4);
    expect(groups.every(group => group.cwd === undefined)).toBe(true);
    expect(groups.every(group => group.label.includes('Unknown workspace'))).toBe(true);
    expect(groups.flatMap(group => group.agents)).toHaveLength(agents.length);
  });

  it('disambiguates repeated unknown-session names and uses collision-free key namespaces', () => {
    const agents = [agent(0, { sessionId: '/repo' }), agent(1, { sessionId: 'second' }), agent(2, { cwd: '/repo' })];
    const groups = groupWorkspaces(agents);
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map(group => group.label)).size).toBe(3);
    expect(new Set(groups.map(group => group.key)).size).toBe(3);
    expect(groups.find(group => group.cwd === '/repo')?.label).toBe('repo');
    expect(groups.find(group => group.sessionIds[0] === 'second')?.label).toBe('Workshop · Unknown workspace · second');
  });

  it('keeps labels deterministic and unique when literal names collide with generated labels', () => {
    const agents = [
      agent(0, { cwd: '/a/name' }), agent(1, { cwd: '/b/name' }),
      agent(2, { cwd: '/a/visible\u202e' }), agent(3, { cwd: '/a/visible' }),
      agent(4, { sessionId: 'x', sessionName: '' }), agent(5, { sessionId: 'y', sessionName: '' }),
      agent(6, { cwd: '/Untitled session · Unknown workspace · x' }),
    ];
    const labels = (input: typeof agents) => groupWorkspaces(input).map(({ key, label }) => [key, label]);
    const groups = groupWorkspaces(agents);
    expect(new Set(groups.map(group => group.label)).size).toBe(groups.length);
    expect(groups.every(group => !/[\u202e]/u.test(group.label))).toBe(true);
    expect(labels(agents)).toEqual(labels([...agents].reverse()));
  });

  it('preserves project identity across session rename, partial departure, and reconnect', () => {
    const first = agent(0, { cwd: '/project' });
    const second = agent(1, { cwd: '/project', sessionId: 'second' });
    const selected = workspaceKey(first);
    expect(reconcileWorkspaceSelection(groupWorkspaces([first, second]), selected)).toBe(selected);
    expect(reconcileWorkspaceSelection(groupWorkspaces([{ ...second, sessionName: 'Renamed' }]), selected)).toBe(selected);
    expect(reconcileWorkspaceSelection(groupWorkspaces([]), selected)).toBe('');
    expect(workspaceKey(agent(2, { cwd: '/project', sessionId: 'third' }))).toBe(selected);
    expect(reconcileWorkspaceSelection(groupWorkspaces([first]), 'missing')).toBe('');
  });

  it('updates group identity when authoritative cwd changes without losing the session roster', () => {
    const original = [agent(0, { cwd: '/old' }), agent(1, { cwd: '/old' })];
    const selected = workspaceKey(original[0]);
    const updated = original.map(item => ({ ...item, cwd: '/new' }));
    const groups = groupWorkspaces(updated);
    expect(groups).toHaveLength(1);
    expect(groups[0].cwd).toBe('/new');
    expect(groups[0].agents.map(item => item.key)).toEqual(original.map(item => item.key));
    expect(reconcileWorkspaceSelection(groups, selected)).toBe('');
  });

  it('creates no historical projects and does not revive failed or stale snapshots', () => {
    const store = new StateStore();
    store.accept(state([agent(0, { cwd: '/active' }), agent(1, { cwd: '/offline', state: 'offline' }), agent(2, { cwd: '/stale', state: 'stale' })]));
    expect(groupWorkspaces(liveAgents(store.current)).map(group => group.cwd)).toEqual(['/active']);
    store.disconnect('Lost connection');
    expect(groupWorkspaces(liveAgents(store.current))).toEqual([]);
    expect(store.accept(state([agent(0, { cwd: '/active' })]))).toBe('stale');
    expect(groupWorkspaces(liveAgents(store.current))).toEqual([]);
    store.accept(state([agent(0, { cwd: '/active' })], 2));
    expect(groupWorkspaces(liveAgents(store.current))).toHaveLength(1);
    store.accept(state([], 3));
    expect(groupWorkspaces(liveAgents(store.current))).toEqual([]);
  });

  it('retains agents beyond the artwork limit without deduplicating session-local agent IDs', () => {
    const agents = Array.from({ length: 160 }, (_, index) => agent(index % 64, {
      key: `session-${Math.floor(index / 64)}/${index % 64}`,
      sessionId: `session-${Math.floor(index / 64)}`,
      cwd: '/project',
    }));
    const groups = groupWorkspaces(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0].agents).toHaveLength(160);
    expect(groups[0].sessionIds).toHaveLength(3);
    expect(new Set(groups[0].agents.map(item => item.key)).size).toBe(160);
  });

  it('does not mutate the input roster or infer missing cwd from another agent in its session', () => {
    const agents = [agent(1, { cwd: '/project' }), agent(0)];
    const original = structuredClone(agents);
    expect(groupWorkspaces(agents)).toHaveLength(2);
    expect(agents).toEqual(original);
  });
});
