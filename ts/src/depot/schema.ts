export interface Problem {
  readonly path: string;
  readonly expected: string;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly Problem[] };

export interface Schema<T> {
  readonly describe: string;
  readonly check: (value: unknown, path: string) => readonly Problem[];
}

export type Of<S> = S extends Schema<infer T> ? T : never;

const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));
const problem = (path: string, expected: string): readonly Problem[] => [{ path: path || '(root)', expected }];

export const number: Schema<number> = {
  describe: 'a finite number',
  check: (value, path) => (typeof value === 'number' && Number.isFinite(value) ? [] : problem(path, 'a finite number')),
};

export const text: Schema<string> = {
  describe: 'a string',
  check: (value, path) => (typeof value === 'string' ? [] : problem(path, 'a string')),
};

export function within(low: number, high: number): Schema<number> {
  const describe = `a number from ${low} to ${high}`;
  return { describe, check: (value, path) => (typeof value === 'number' && value >= low && value <= high ? [] : problem(path, describe)) };
}

export function tuple<T extends readonly Schema<unknown>[]>(...items: T): Schema<{ readonly [K in keyof T]: Of<T[K]> }> {
  const describe = `[${items.map((item) => item.describe).join(', ')}]`;
  return {
    describe,
    check: (value, path) => {
      if (!Array.isArray(value) || value.length !== items.length) return problem(path, describe);
      return items.flatMap((item, index) => item.check(value[index], at(path, index)));
    },
  };
}

export function list<T>(item: Schema<T>): Schema<readonly T[]> {
  return {
    describe: `a list of ${item.describe}`,
    check: (value, path) => (Array.isArray(value) ? value.flatMap((entry, index) => item.check(entry, at(path, index))) : problem(path, `a list of ${item.describe}`)),
  };
}

export function record<T extends Record<string, Schema<unknown>>>(fields: T): Schema<{ readonly [K in keyof T]: Of<T[K]> }> {
  const names = Object.keys(fields);
  return {
    describe: `{ ${names.join(', ')} }`,
    check: (value, path) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return problem(path, `an object with ${names.join(', ')}`);
      const unknown = Object.keys(value).filter((key) => !(key in fields)).map((key) => ({ path: at(path, key), expected: 'no such field' }));
      return [...names.flatMap((name) => fields[name].check((value as Record<string, unknown>)[name], at(path, name))), ...unknown];
    },
  };
}

export function parse<T>(schema: Schema<T>, value: unknown): Parsed<T> {
  const problems = schema.check(value, '');
  return problems.length === 0 ? { ok: true, value: value as T } : { ok: false, problems };
}

export class InvalidData extends Error {
  readonly problems: readonly Problem[];

  constructor(source: string, problems: readonly Problem[]) {
    super(`${source}: ${problems.map(({ path, expected }) => `${path} should be ${expected}`).join('; ')}`);
    this.problems = problems;
  }
}

export function load<T>(source: string, schema: Schema<T>, value: unknown): T {
  const parsed = parse(schema, value);
  if (!parsed.ok) throw new InvalidData(source, parsed.problems);
  return parsed.value;
}

export function assigned(value: unknown, path: string, replacement: unknown): unknown {
  const [head, ...rest] = path.split('.');
  if (head === undefined || head === '') return replacement;
  const tail = rest.join('.');
  if (Array.isArray(value)) {
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0 || index >= value.length) throw new RangeError(`no element ${head} at ${path}`);
    return value.map((entry, position) => (position === index ? assigned(entry, tail, replacement) : entry));
  }
  if (typeof value !== 'object' || value === null || !(head in value)) throw new RangeError(`no field ${head} at ${path}`);
  return { ...(value as Record<string, unknown>), [head]: assigned((value as Record<string, unknown>)[head], tail, replacement) };
}

export function formatted(value: unknown): string {
  const indented = JSON.stringify(value, null, 2);
  return `${indented.replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+)*)\s*\]/g, (_, numbers: string) => `[${numbers.split(/,\s*/).join(', ')}]`)}\n`;
}
