import type { Agent } from './model';

/** Display-only fiction. Scheduling and mode selection belong to the UI. */
export const DEMO_INTERVAL_MS = 4000;

const CAST = [
  { agentId: 'pip', name: 'Pip', role: 'Planner' },
  { agentId: 'moss', name: 'Moss', role: 'Builder' },
  { agentId: 'nova', name: 'Nova', role: 'Designer' },
  { agentId: 'echo', name: 'Echo', role: 'Researcher' },
  { agentId: 'taro', name: 'Taro', role: 'Reviewer' },
  { agentId: 'lumi', name: 'Lumi', role: 'Writer' },
] as const;

type Activity = Pick<Agent, 'state' | 'task' | 'tool'>;
const ACTIVITIES: readonly Activity[] = [
  { state: 'thinking', task: 'Planning a tiny moon garden' },
  { state: 'working', task: 'Sketching a cozy observatory', tool: 'demo canvas' },
  { state: 'working', task: 'Arranging imaginary star charts', tool: 'demo notebook' },
  { state: 'waiting', task: 'Choosing a color for the moon gate' },
  { state: 'working', task: 'Building a pretend constellation map', tool: 'demo editor' },
  { state: 'completed', task: 'Finished the paper rocket prototype' },
  { state: 'idle', task: 'Ready for the next imaginary mission' },
  { state: 'thinking', task: 'Comparing names for a cloud cafe' },
  { state: 'working', task: 'Writing a story about friendly comets', tool: 'demo notebook' },
  { state: 'error', task: 'An imaginary puzzle piece does not fit' },
  { state: 'working', task: 'Checking the toy telescope design', tool: 'demo preview' },
  { state: 'completed', task: 'Finished the cloud cafe menu' },
];

function index(length: number, random: () => number): number {
  // Bound injected values too, so a bad random source cannot create invalid agents.
  const value = random();
  return Number.isFinite(value) ? Math.min(length - 1, Math.max(0, Math.floor(value * length))) : 0;
}

function makeAgent(identity: typeof CAST[number], activity: Activity): Agent {
  return {
    ...identity,
    key: `demo/${identity.agentId}`,
    sessionId: 'demo/synthetic-session',
    sessionName: 'Demo studio (simulated)',
    cwd: 'demo/imaginary-studio',
    model: 'Simulated',
    ...activity,
  };
}

/** Start with all six designs visible, without consulting any live state. */
export function createDemoAgents(random: () => number = Math.random): Agent[] {
  return CAST.map(identity => makeAgent(identity, ACTIVITIES[index(ACTIVITIES.length, random)]));
}

/** Keep stable identities while fictional membership and activities change. */
export function advanceDemoAgents(previous: readonly Agent[], random: () => number = Math.random): Agent[] {
  const targetCount = 2 + index(5, random);
  const previousByKey = new Map(previous.map(agent => [agent.key, agent]));
  const selected = CAST.filter(identity => previousByKey.has(`demo/${identity.agentId}`));
  while (selected.length > targetCount) selected.splice(index(selected.length, random), 1);
  const available = CAST.filter(identity => !selected.includes(identity));
  while (selected.length < targetCount) selected.push(available.splice(index(available.length, random), 1)[0]);

  return selected.map(identity => {
    const old = previousByKey.get(`demo/${identity.agentId}`);
    const current = ACTIVITIES.findIndex(activity => activity.task === old?.task && activity.state === old?.state);
    // Some agents stay on a task for more than one tick. Others advance to a
    // different predefined activity; nothing from a caller becomes display text.
    const next = current >= 0
      ? (index(4, random) === 0 ? current : (current + 1 + index(ACTIVITIES.length - 1, random)) % ACTIVITIES.length)
      : index(ACTIVITIES.length, random);
    return makeAgent(identity, ACTIVITIES[next]);
  });
}
