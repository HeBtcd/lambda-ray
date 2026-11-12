import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { checkLaws, loadProfile } = await import(pathToFileURL(join(root, 'ts/tools/laws.mjs')).href);

const work = join(root, '.cache/systest/ts-pure');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'src'), { recursive: true });
writeFileSync(join(work, 'src/lib.ts'), `export function pure<T>(fn: T): T { return fn; }

export const good = pure((a: number, b: number) => a + b);
export const bad = pure(() => Date.now() + Math.random());
let calls = 0;
export const hidden = pure(() => calls++);
export const writer = pure((xs: number[]) => { xs.push(1); return xs; });
`);

const found = checkLaws({ root: work, profile: loadProfile('ts-pure') });
const messages = found.map((v) => v.message).join('\n');
for (const expect of ['reads Date', 'Math.random', 'calls', 'push on xs']) {
  if (!messages.includes(expect)) { console.error(`missing: ${expect}\n${messages}`); process.exit(1); }
}
if (found.some((v) => v.at.includes(':2:'))) { console.error('lawful function flagged\n' + messages); process.exit(1); }
console.log('ts-pure: ok');
