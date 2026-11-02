import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp, parseEvent, validSignature } from '../src/app.js';
import { complete } from '../src/model.js';
import { runProcess } from '../src/tasks.js';

const secrets = { ADMIN_TOKEN: 'a'.repeat(40), ONEBOT_SECRET: 'b'.repeat(40), ONEBOT_TOKEN: 'c'.repeat(40) };
const env = { ...secrets, ALLOWED_USERS: '101,102', ALLOWED_GROUPS: '201' };
function event(text, id = 1, user = 101) {
  return { post_type: 'message', message_type: 'private', user_id: user, self_id: 999, message_id: id, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }] };
}
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
test('configuration rejects placeholders, duplicate secrets and unsafe URLs', () => {
  assert.throws(() => loadConfig({}));
  assert.throws(() => loadConfig({ ...env, ONEBOT_TOKEN: secrets.ADMIN_TOKEN }));
  assert.throws(() => loadConfig({ ...env, MODEL_BASE_URL: 'file:///tmp/test' }));
  assert.equal(loadConfig(env).allowedUsers.size, 2);
  assert.equal(loadConfig(secrets).allowedUsers.size, 0);
});
test('authorization requires both group and user allowlists, explicit mention and fresh events', () => {
  const config = loadConfig(env);
  assert.equal(parseEvent(event('hello', 1, 500), config), null);
  const group = { ...event('hi'), message_type: 'group', group_id: 201 };
  assert.equal(parseEvent(group, config), null);
  group.message.push({ type: 'at', data: { qq: 999 } });
  assert.ok(parseEvent(group, config));
  assert.equal(parseEvent({ ...group, group_id: 202 }, config), null);
  assert.equal(parseEvent({ ...group, user_id: 500 }, config), null);
  assert.equal(parseEvent({ ...group, time: 1 }, config), null);
  assert.equal(parseEvent({ ...group, message: '[CQ:at,qq=999]hi' }, config), null);
});
test('signature covers exact raw body', () => {
  const raw = Buffer.from('{"message":"中文"}');
  const signature = `sha1=${createHmac('sha1', secrets.ONEBOT_SECRET).update(raw).digest('hex')}`;
  assert.ok(validSignature(raw, signature, secrets.ONEBOT_SECRET));
  assert.equal(validSignature(Buffer.from('{}'), signature, secrets.ONEBOT_SECRET), false);
  assert.equal(validSignature(raw, undefined, secrets.ONEBOT_SECRET), false);
});
test('real HTTP webhook: auth, deduplication, session ordering, persistence, reset, task confirmation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'linux-contact-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const replies = [], prompts = [];
  const onebot = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secrets.ONEBOT_TOKEN}`);
    let body = ''; for await (const chunk of req) body += chunk;
    replies.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json'); res.end('{"status":"ok","retcode":0}');
  });
  const onebotUrl = await listen(onebot);
  t.after(() => new Promise(resolve => onebot.close(resolve)));
  const tasksFile = join(dir, 'tasks.json');
  await writeFile(tasksFile, JSON.stringify({ probe: { command: process.execPath, args: ['-e', 'console.log("task-ok");console.log(process.env.ADMIN_TOKEN || "no-secret")'], timeoutMs: 5000 } }));
  const config = loadConfig({ ...env, ONEBOT_URL: onebotUrl, DATA_DIR: join(dir, 'data'), WORKSPACE_DIR: join(dir, 'workspace'), TASKS_FILE: tasksFile, ENABLE_TASKS: 'true' });
  const options = { model: async (_, history) => { prompts.push(structuredClone(history)); return '回复[CQ:at,qq=all]'; }, logger: { error() {} } };
  let app = await createApp(config, options), url = await listen(app.server);
  t.after(async () => { if (app.server.listening) await app.close(); });
  const post = (data, signature = true) => {
    const raw = JSON.stringify(data);
    return fetch(`${url}/api/onebot/event`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Signature': `sha1=${createHmac('sha1', secrets.ONEBOT_SECRET).update(raw).digest('hex')}` } : {}) }, body: raw });
  };
  assert.equal((await fetch(`${url}/api/status`)).status, 401);
  assert.equal((await fetch(`${url}/api/status`, { headers: { Authorization: `Bearer ${secrets.ADMIN_TOKEN}` } })).status, 200);
  assert.equal((await post(event('no-signature'), false)).status, 401);
  await post(event('unauthorized', 1, 500));
  await app.idle(); assert.equal(replies.length, 0);
  await post(event('first', 2)); await post(event('second', 3)); await post(event('second', 3));
  await app.idle();
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1][0].content, 'first');
  assert.deepEqual(replies[0].message, [{ type: 'text', data: { text: '回复[CQ:at,qq=all]' } }]);
  await post(event('separate', 4, 102)); await app.idle(); assert.equal(prompts[2].length, 1);
  await app.close();
  app = await createApp(config, options); url = await listen(app.server);
  await post(event('after restart', 5)); await app.idle(); assert.equal(prompts.at(-1)[0].content, 'first');
  await post(event('/运行 probe', 6)); await app.idle();
  const token = replies.at(-1).message[0].data.text.match(/确认 ([a-f0-9]+)/)[1];
  await post(event(`/确认 ${token}`, 7, 102)); await app.idle(); assert.match(replies.at(-1).message[0].data.text, /无效/);
  await post(event(`/确认 ${token}`, 8)); await app.idle();
  assert.match(replies.at(-1).message[0].data.text, /task-ok\s+no-secret/);
  await post(event(`/确认 ${token}`, 9)); await app.idle(); assert.match(replies.at(-1).message[0].data.text, /无效/);
  await post(event('/重置', 10)); await app.idle();
  await post(event('fresh', 11)); await app.idle(); assert.equal(prompts.at(-1).length, 1);
});
test('API adapter sends correct model context; provider errors do not leak bodies', async t => {
  let fail = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fake-test-key');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw);
    assert.equal(data.model, 'test-model'); assert.equal(data.messages[0].role, 'system');
    res.writeHead(fail ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(fail ? '{"secret":"must-not-leak"}' : '{"choices":[{"message":{"content":"成功"}}]}');
  });
  const url = await listen(server); t.after(() => new Promise(resolve => server.close(resolve)));
  const config = loadConfig({ ...env, MODEL_BASE_URL: `${url}/v1`, MODEL_API_KEY: 'fake-test-key', MODEL_NAME: 'test-model' });
  assert.equal(await complete(config, [{ role: 'user', content: 'hi' }]), '成功');
  fail = true;
  await assert.rejects(complete(config, []), error => error.message === 'Model HTTP 401');
});
test('task runner enforces timeout/output limits and never interprets shell syntax', async () => {
  const literal = 'hello; echo injected';
  const result = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', literal]);
  assert.equal(result.output.trim(), literal);
  const slow = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 200 });
  assert.equal(slow.timedOut, true);
  const large = await runProcess(process.execPath, ['-e', 'console.log("x".repeat(30000))'], { limit: 100 });
  assert.equal(large.truncated, true); assert.ok(large.output.length <= 100);
});
