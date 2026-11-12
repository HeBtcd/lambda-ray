export type Seed = number;

export function draw(seed: Seed): readonly [number, Seed] {
  const next = (seed + 0x9e3779b9) >>> 0;
  let mixed = next;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97) >>> 0;
  mixed = (mixed ^ (mixed >>> 15)) >>> 0;
  return [mixed / 0x100000000, next];
}

export function between(seed: Seed, low: number, high: number): readonly [number, Seed] {
  const [unit, next] = draw(seed);
  return [low + unit * (high - low), next];
}
