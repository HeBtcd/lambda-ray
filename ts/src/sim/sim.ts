export interface Sim<S, C> {
  readonly stepsPerSecond: number;
  readonly init: S;
  readonly step: (state: S, commands: readonly C[]) => S;
}

export type Log<C> = readonly (readonly C[])[];

export type Impurity = 'Math.random' | 'Date.now' | 'performance.now' | 'mutated its input';

export class ImpureStep extends Error {
  readonly impurity: Impurity;
  readonly tick: number;

  constructor(impurity: Impurity, tick: number) {
    super(`step at tick ${tick} ${impurity === 'mutated its input' ? impurity : `called ${impurity}`}`);
    this.impurity = impurity;
    this.tick = tick;
  }
}

function freeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
  return value;
}

function guarded<T>(tick: number, run: () => T): T {
  const originals = { random: Math.random, now: Date.now, perf: globalThis.performance?.now };
  const refuse = (impurity: Impurity) => () => {
    throw new ImpureStep(impurity, tick);
  };
  Math.random = refuse('Math.random');
  Date.now = refuse('Date.now');
  if (globalThis.performance) globalThis.performance.now = refuse('performance.now');
  try {
    return run();
  } catch (error) {
    if (error instanceof TypeError && /read.only|frozen|not extensible|Cannot (assign|add|delete|define)/i.test(error.message)) throw new ImpureStep('mutated its input', tick);
    throw error;
  } finally {
    Math.random = originals.random;
    Date.now = originals.now;
    if (globalThis.performance && originals.perf) globalThis.performance.now = originals.perf;
  }
}

export function stepOnce<S, C>(sim: Sim<S, C>, state: S, commands: readonly C[], tick: number): S {
  return freeze(guarded(tick, () => sim.step(freeze(state), freeze(commands))));
}

export function replay<S, C>(sim: Sim<S, C>, from: S, log: Log<C>, fromTick: number, toTick: number): S {
  let state = from;
  for (let tick = fromTick; tick < toTick; tick++) state = stepOnce(sim, state, log[tick] ?? [], tick);
  return state;
}

export function seek<S, C>(sim: Sim<S, C>, log: Log<C>, tick: number): S {
  if (!Number.isInteger(tick) || tick < 0 || tick > log.length) throw new RangeError(`tick ${tick} is outside the log (0..${log.length})`);
  return replay(sim, freeze(sim.init), log, 0, tick);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return `"${value}"`;
  return JSON.stringify(value) ?? 'null';
}

export function hashOf(state: unknown): string {
  const text = canonical(state);
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x5bd1e995) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

export interface Synctest {
  readonly ok: boolean;
  readonly tick: number;
  readonly direct: string;
  readonly halfway: string;
  readonly again: string;
}

export function synctest<S, C>(sim: Sim<S, C>, log: Log<C>, tick = log.length): Synctest {
  const half = Math.floor(tick / 2);
  const direct = hashOf(seek(sim, log, tick));
  const halfway = hashOf(replay(sim, seek(sim, log, half), log, half, tick));
  const again = hashOf(seek(sim, log, tick));
  return { ok: direct === halfway && direct === again, tick, direct, halfway, again };
}

export interface Layer<M, I, O> {
  readonly init: M;
  readonly step: (memory: M, input: I) => M;
  readonly out: (memory: M) => O;
}

export interface Composed<S, M> {
  readonly sim: S;
  readonly layer: M;
}

export function contramap<M, I, J, O>(layer: Layer<M, I, O>, from: (input: J) => I): Layer<M, J, O> {
  return { init: layer.init, step: (memory, input) => layer.step(memory, from(input)), out: layer.out };
}

export function andThen<S, C, M, O>(sim: Sim<S, C>, layer: Layer<M, S, O>): Sim<Composed<S, M>, C> {
  return {
    stepsPerSecond: sim.stepsPerSecond,
    init: { sim: sim.init, layer: layer.init },
    step: (state, commands) => {
      const next = sim.step(state.sim, commands);
      return { sim: next, layer: layer.step(state.layer, next) };
    },
  };
}

export function outOf<S, M, O>(layer: Layer<M, S, O>, state: Composed<S, M>): O {
  return layer.out(state.layer);
}

export function foldLayer<M, I, O>(layer: Layer<M, I, O>, inputs: readonly I[]): M {
  return inputs.reduce((memory, input, tick) => guarded(tick, () => layer.step(freeze(memory), freeze(input))), freeze(layer.init));
}

export function windowed<M, I, O>(layer: Layer<M, I, O>, inputs: readonly I[], tick: number, warm: number): O {
  return layer.out(foldLayer(layer, inputs.slice(Math.max(0, tick - warm), tick)));
}
