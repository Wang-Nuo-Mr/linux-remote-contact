import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete } from '../src/model.js';

test('Linux Codex adapter supplies stdin, read-only sandbox, output file and restricted env', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'contact-codex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'codex-stub');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if(args[0] !== 'exec' || args[args.indexOf('--sandbox')+1] !== 'read-only' || args.at(-1) !== '-') process.exit(2);
if(process.env.ADMIN_TOKEN || process.env.MODEL_API_KEY) process.exit(3);
let input = ''; process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if(!input.includes('adapter-test')) process.exit(4);
  fs.writeFileSync(args[args.indexOf('--output-last-message')+1], 'CLI adapter reply');
});
`, { mode: 0o700 });
  const result = await complete({ backend: 'codex', codexBin: executable, workspace: dir, timeout: 5000 }, [{ role: 'user', content: 'adapter-test' }]);
  assert.equal(result, 'CLI adapter reply');
});
