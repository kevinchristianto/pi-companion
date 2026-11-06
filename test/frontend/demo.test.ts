import { describe, expect, it } from 'vitest';
import { advanceDemoAgents, createDemoAgents, DEMO_INTERVAL_MS } from '../../src/demo';
import { AGENT_STATES } from '../../src/model';
import type { Agent } from '../../src/model';

function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

describe('display-only demo roster', () => {
  it('starts with six uniquely named synthetic agents in one synthetic workspace', () => {
    const agents = createDemoAgents(seeded(42));
    expect(agents).toHaveLength(6);
    expect(new Set(agents.map(agent => agent.key)).size).toBe(6);
    expect(new Set(agents.map(agent => agent.name)).size).toBe(6);
    expect(new Set(agents.map(agent => agent.sessionId)).size).toBe(1);
    expect(new Set(agents.map(agent => agent.cwd)).size).toBe(1);
    for (const agent of agents) {
      expect(agent.key).toBe(`demo/${agent.agentId}`);
      expect(agent.cwd).toBe('demo/imaginary-studio');
      expect(agent.sessionName).toContain('simulated');
      expect(agent.model).toBe('Simulated');
      expect(AGENT_STATES).toContain(agent.state);
    }
    expect(DEMO_INTERVAL_MS).toBeGreaterThanOrEqual(3000);
  });

  it('is deterministic for the same random sequence', () => {
    const first = seeded(123);
    const second = seeded(123);
    let a = createDemoAgents(first);
    let b = createDemoAgents(second);
    for (let tick = 0; tick < 50; tick++) {
      expect(a).toEqual(b);
      a = advanceDemoAgents(a, first);
      b = advanceDemoAgents(b, second);
    }
  });

  it('varies membership and activities while preserving its six identities', () => {
    const random = seeded(27);
    const initial = createDemoAgents(random);
    const identities = new Map(initial.map(({ key, agentId, name, role }) => [key, { key, agentId, name, role }]));
    let agents = initial;
    const counts = new Set<number>();
    const states = new Set<string>();
    const tasks = new Set<string>();
    const tools = new Set<string>();
    for (let tick = 0; tick < 100; tick++) {
      agents = advanceDemoAgents(agents, random);
      counts.add(agents.length);
      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents.length).toBeLessThanOrEqual(6);
      expect(new Set(agents.map(agent => agent.key)).size).toBe(agents.length);
      for (const agent of agents) {
        expect(identities.has(agent.key)).toBe(true);
        expect(agent).toMatchObject(identities.get(agent.key)!);
        states.add(agent.state);
        tasks.add(agent.task);
        if (agent.tool) tools.add(agent.tool);
        if (agent.state !== 'working') expect(agent.tool).toBeUndefined();
      }
    }
    expect([...counts].sort()).toEqual([2, 3, 4, 5, 6]);
    expect(states.size).toBeGreaterThanOrEqual(6);
    expect(tasks.size).toBeGreaterThan(6);
    expect(tools.size).toBeGreaterThan(1);
  });

  it('never mutates or reuses objects from an earlier snapshot', () => {
    const original = createDemoAgents(seeded(8));
    const saved = structuredClone(original);
    original.forEach(Object.freeze);
    Object.freeze(original);
    const next = advanceDemoAgents(original, seeded(9));
    expect(original).toEqual(saved);
    for (const agent of next) expect(original).not.toContain(agent);
    next[0].task = 'changed by caller';
    expect(original).toEqual(saved);
    expect(createDemoAgents(seeded(8))).toEqual(saved);
  });

  it('recovers from empty input and does not carry foreign live data into the demo', () => {
    expect(advanceDemoAgents([], () => 0)).toHaveLength(2);
    const foreign = { ...createDemoAgents(() => 0)[0], name: 'Private name', task: 'Private task', cwd: '/private', tool: 'private tool', model: 'private model' };
    const next = advanceDemoAgents([foreign, { ...foreign, key: 'live/agent' }], () => 0);
    expect(JSON.stringify(next)).not.toMatch(/private/i);
    expect(next.every(agent => agent.key.startsWith('demo/'))).toBe(true);
  });

  it.each([0, 1, -1, NaN, Infinity])('bounds injected random value %s', value => {
    let agents: Agent[] = createDemoAgents(() => value);
    for (let tick = 0; tick < 5; tick++) agents = advanceDemoAgents(agents, () => value);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.length).toBeLessThanOrEqual(6);
    expect(agents.every(agent => AGENT_STATES.includes(agent.state))).toBe(true);
  });
});
