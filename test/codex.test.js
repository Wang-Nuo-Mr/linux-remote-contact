import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { complete, companion, work } from '../src/model.js';

test('Linux Codex adapter supplies stdin, read-only sandbox, output file and restricted env', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'contact-codex-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'codex-stub');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if(!args.includes('exec') || args[args.indexOf('--sandbox')+1] !== 'read-only' || args.at(-1) !== '-') process.exit(2);
if(!args.includes('--ignore-user-config') || !args.includes('--ignore-rules') || !args.includes('--ephemeral') || args[args.indexOf('--ask-for-approval')+1] !== 'never') process.exit(5);
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

test('Linux Codex structured chat and confirmed work select their intended sandboxes', { skip: process.platform === 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'contact-structured-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const executable = join(dir, 'codex-stub');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
const sandbox = args[args.indexOf('--sandbox')+1];
let input = ''; process.stdin.on('data', c=>input+=c);
process.stdin.on('end', () => {
 if(args.includes('--output-schema')) {
   if(sandbox!=='read-only') process.exit(2);
   JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1], 'utf8'));
   fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({shouldReply:true,reply:'你好',memories:[{subject:null,label:'name',text:'称呼用户小王'}],task:null}));
 } else {
   if(sandbox!=='workspace-write') process.exit(3);
   fs.writeFileSync('answer.txt','42');
   fs.writeFileSync(args[args.indexOf('--output-last-message')+1], '已生成answer.txt');
 }
});
`, { mode: 0o700 });
  const config = { backend: 'codex', codexBin: executable, workspace: dir, timeout: 5000, workTimeout: 5000 };
  assert.equal((await companion(config, [{role:'user',content:'你好'}], {})).reply, '你好');
  assert.equal(await work(config, 'write a file', dir), '已生成answer.txt');
});
