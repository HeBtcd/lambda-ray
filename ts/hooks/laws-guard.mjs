#!/usr/bin/env node
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const core = resolve(root, 'core');

function say(message) {
  process.stdout.write(JSON.stringify(message));
  process.exit(0);
}

let data = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) data += chunk;

let payload;
try {
  payload = JSON.parse(data.replace(/^\ufeff/, '') || '{}');
} catch (error) {
  say({ systemMessage: `laws: not checked (the tool payload was not JSON: ${error.message})` });
}

const path = payload?.tool_response?.filePath || payload?.tool_input?.file_path || '';
const inCore = relative(core, resolve(path)).split(sep).join('/');
if (!path || !inCore.startsWith('src/') || !/\.(ts|tsx|json)$/.test(inCore)) process.exit(0);

let laws;
try {
  laws = await import(pathToFileURL(resolve(core, 'tools/laws.mjs')).href);
} catch (error) {
  say({ systemMessage: `laws: not checked (core/tools/laws.mjs did not load: ${error.message}; run npm install in core)` });
}

const violations = laws.checkLaws({ root: core });
if (violations.length === 0) process.exit(0);
say({ decision: 'block', reason: `This edit leaves ${violations.length} violation(s) of the laws (docs/laws.md). Fix them before going on:\n\n${laws.formatted(violations)}` });
