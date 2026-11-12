#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

function say(message) {
  process.stdout.write(JSON.stringify(message));
  process.exit(0);
}

let data = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) data += chunk;

let payload;
try {
  payload = JSON.parse(data.replace(/^﻿/, '') || '{}');
} catch (error) {
  say({ systemMessage: `laws: not checked (the tool payload was not JSON: ${error.message})` });
}

const profileName = process.env.DOG_PURITY_PROFILE ?? 'ts-fold';
const path = payload?.tool_response?.filePath || payload?.tool_input?.file_path || '';
const suffixes = { 'ts-fold': /\.(ts|tsx|json)$/, 'ts-pure': /\.(ts|tsx)$/ };
const relevant = relative(root, resolve(path)).split(sep).join('/');
if (!path || !(suffixes[profileName] ?? /\.(ts|tsx|json)$/).test(path)) process.exit(0);

let laws;
try {
  laws = await import(pathToFileURL(resolve(HERE, '../tools/laws.mjs')).href);
} catch (error) {
  say({ systemMessage: `laws: not checked (ts/tools/laws.mjs did not load: ${error.message})` });
}

const violations = laws.checkLaws({ root, profile: laws.loadProfile(profileName) });
if (violations.length === 0) process.exit(0);
say({ decision: 'block', reason: `This edit leaves ${violations.length} violation(s) of the laws (${profileName}). Fix them before going on:\n\n${laws.formatted(violations)}` });
