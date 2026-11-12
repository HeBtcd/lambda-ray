import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkLaws, DEPOT, KERNEL, LAWS } from './laws.mjs';

const repoRoot = resolve(import.meta.dirname, '..');
const SIM = "import type { Sim } from '../sim/sim';\n";

const FIXTURES = {
  'src/game/good.ts': `${SIM}import { load, number, record } from '../depot/schema';
import data from './tuning.json';
type Kind = { readonly kind: 'move'; readonly by: number } | { readonly kind: 'reset' };
const TUNING = load('src/game/tuning.json', record({ speed: number }), data);
const fresh = () => ({ at: 0, trail: [] as number[] });
export const good: Sim<{ readonly at: number; readonly trail: readonly number[] }, Kind> = {
  stepsPerSecond: 60,
  init: fresh(),
  step: (state, commands) => {
    const trail: number[] = [...state.trail];
    let at = state.at;
    for (const command of commands) {
      if (command.kind === 'reset') return fresh();
      at += command.by * TUNING.speed;
      trail.push(at);
    }
    return { at, trail: [...trail].sort((a, b) => a - b) };
  },
};
`,
  'src/game/layers.ts': `import type { Layer } from '../sim/sim';
export const clean: Layer<{ readonly seen: number }, number, number> = { init: { seen: 0 }, step: (memory, n) => ({ seen: memory.seen + n }), out: (memory) => memory.seen };
export const drifting: Layer<{ readonly seen: number }, number, number> = { init: { seen: 0 }, step: (memory) => memory, out: (memory) => memory.seen + performance.now() };
export const closure: Layer<{ readonly then: () => void }, number, number> = { init: { then: () => {} }, step: (memory) => memory, out: () => 0 };
`,
  'src/game/tuning.json': '{ "speed": 2 }\n',
  'src/game/raw.json': '{ "speed": 3 }\n',
  'src/game/closure.ts': `${SIM}export const closure: Sim<{ readonly onHit: () => void }, never> = { stepsPerSecond: 60, init: { onHit: () => {} }, step: (state) => state };
`,
  'src/game/map.ts': `${SIM}export const map: Sim<{ readonly seen: Map<string, number> }, never> = { stepsPerSecond: 60, init: { seen: new Map() }, step: (state) => state };
`,
  'src/game/command.ts': `${SIM}type S = { readonly n: number };
export const command: Sim<S, (s: S) => S> = { stepsPerSecond: 60, init: { n: 0 }, step: (state, commands) => commands.reduce((s, f) => f(s), state) };
`,
  'src/game/dice.ts': `${SIM}const roll = () => Math.floor(Math.random() * 6);
export const dice: Sim<{ readonly n: number }, never> = { stepsPerSecond: 60, init: { n: 0 }, step: () => ({ n: roll() }) };
`,
  'src/game/clock.ts': `${SIM}export const clock: Sim<{ readonly at: number }, never> = { stepsPerSecond: 60, init: { at: 0 }, step: () => ({ at: Date.now() }) };
`,
  'src/game/inplace.ts': `${SIM}type S = { readonly items: number[] };
function grow(state: S) {
  state.items.push(1);
  return state;
}
export const inplace: Sim<S, never> = { stepsPerSecond: 60, init: { items: [] }, step: (state) => grow(state) };
`,
  'src/game/hidden.ts': `${SIM}let calls = 0;
export const hidden: Sim<{ readonly n: number }, never> = { stepsPerSecond: 60, init: { n: 0 }, step: () => ({ n: calls }) };
export function bump() {
  calls++;
}
`,
  'src/game/engine.ts': `${SIM}import * as UE from 'ue';
export const engine: Sim<{ readonly t: number }, never> = { stepsPerSecond: 60, init: { t: 0 }, step: () => ({ t: UE.GameplayStatics.GetTimeSeconds() }) };
`,
  'src/game/truncate.ts': `export function rewind(log: unknown[][], tick: number) {
  log.length = tick;
}
`,
  'src/game/loose.ts': `import data from './raw.json';
export const SPEED = data.speed;
`,
  'src/game/view.tsx': `import { stepOnce } from '../sim/sim';
import { good } from './good';
declare function useSim<S>(sim: unknown, read: () => readonly unknown[]): S;
export function View() {
  const shown = useSim<{ at: number }>(good, () => []);
  shown.at = 5;
  stepOnce(good, { at: 0, trail: [] }, [], 0);
  return null;
}
`,
};

let root;
let found;
const lawsIn = (file) => [...new Set(found.filter((violation) => violation.at.startsWith(`${file}:`)).map((violation) => violation.law))].sort();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'laws-'));
  for (const path of [KERNEL, DEPOT]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  for (const [path, text] of Object.entries(FIXTURES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  found = checkLaws({ root });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the laws', () => {
  it('pass a pure sim over plain data that loads its tuning through a schema and builds its own arrays', () => {
    expect(lawsIn('src/game/good.ts')).toEqual([]);
  });

  it('refuse a function in the state', () => {
    expect(lawsIn('src/game/closure.ts')).toEqual(['state-is-data']);
    expect(found.find((violation) => violation.at.startsWith('src/game/closure.ts')).message).toMatch(/onHit is a function/);
  });

  it('refuse a Map in the state', () => {
    expect(lawsIn('src/game/map.ts')).toEqual(['state-is-data']);
  });

  it('refuse a command that is a function instead of data', () => {
    expect(lawsIn('src/game/command.ts')).toEqual(['commands-are-data']);
  });

  it('follow step into the helpers it calls and name the path', () => {
    const dice = found.filter((violation) => violation.at.startsWith('src/game/dice.ts'));
    expect(dice.map((violation) => violation.law)).toEqual(['step-is-pure']);
    expect(dice[0].message).toMatch(/Math\.random/);
    expect(dice[0].via.join(' ')).toMatch(/roll/);
  });

  it('refuse the clock, writes into the input, hidden module state and the engine', () => {
    expect(lawsIn('src/game/clock.ts')).toEqual(['step-is-pure']);
    expect(lawsIn('src/game/inplace.ts')).toEqual(['step-is-pure']);
    expect(lawsIn('src/game/hidden.ts')).toEqual(['step-is-pure']);
    expect(lawsIn('src/game/engine.ts')).toEqual(['step-is-pure']);
  });

  it('refuse shortening a log', () => {
    expect(lawsIn('src/game/truncate.ts')).toEqual(['log-is-append-only']);
  });

  it('refuse data that skips the schema', () => {
    expect(lawsIn('src/game/loose.ts')).toEqual(['data-enters-through-schema']);
  });

  it('refuse a view that steps the sim or writes into its state', () => {
    const view = found.filter((violation) => violation.at.startsWith('src/game/view.tsx') && violation.law === 'project-never-writes-back');
    expect(view.map((violation) => violation.message).sort()).toEqual(['calls stepOnce outside the shell', 'writes into the sim state through shown.at']);
  });

  it('hold a layer to the same laws, its out included', () => {
    const layers = found.filter((violation) => violation.at.startsWith('src/game/layers.ts'));
    expect(layers.map((violation) => `${violation.at.split(':')[1]} ${violation.law}`).sort()).toEqual(['3 step-is-pure', '4 state-is-data']);
    expect(layers.find((violation) => violation.law === 'step-is-pure').via[0]).toMatch(/^out of the layer/);
  });

  it('give every violation its law and a fix', () => {
    expect(found.every((violation) => LAWS[violation.law] && violation.fix)).toBe(true);
  });
});

describe('this repository', () => {
  it('keeps every law', () => {
    expect(checkLaws({ root: repoRoot })).toEqual([]);
  });
});
