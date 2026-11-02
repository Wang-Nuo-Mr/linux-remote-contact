import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, safeMemory } from '../src/memory.js';
import { Results } from '../src/results.js';
import { splitReply } from '../src/delivery.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

test('long replies retain every character including emoji', () => {
  const original = '长回复🙂\n'.repeat(2000);
  const chunks = splitReply(original);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.map(x => x.replace(/^【\d+\/\d+】\n/, '')).join(''), original);
  assert.ok(chunks.every(x => Array.from(x).length < 3000));
});
test('long-term memory survives restart, isolates conversations and respects explicit corrections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'memory-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new MemoryStore(dir);
  const [fact] = await store.remember('private:1', [{ label:'name', text:'叫我小王' }]);
  store = new MemoryStore(dir);
  assert.equal((await store.get('private:1')).facts[0].id, fact.id);
  assert.equal((await store.get('group:1')).facts.length, 0);
  await store.remember('private:1', [{ label:'name', text:'叫我老王' }], 'manual');
  await store.remember('private:1', [{ label:'name', text:'错误称呼' }]);
  assert.equal((await store.get('private:1')).facts[0].text, '叫我老王');
  const state = await store.get('private:1'); state.automatic=false; await store.put('private:1', state);
  assert.deepEqual(await store.remember('private:1', [{label:'hobby',text:'喜欢猫'}]), []);
  assert.equal(safeMemory('密码是123456'), false);
});
test('result access rejects other sessions, traversal and symlink escapes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'result-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Results(join(dir,'data'), join(dir,'workspace'));
  const result = await store.create('owner', 'test');
  await writeFile(join(result.cwd,'hello.txt'), '完整正文');
  assert.equal(await store.textFile(result, 'hello.txt'), '完整正文');
  await assert.rejects(store.get('other', result.id));
  await assert.rejects(store.textFile(result, '../../outside'));
  if(process.platform !== 'win32') {
    const outside = join(dir,'outside'); await writeFile(outside,'private');
    await symlink(outside, join(result.cwd,'escape.txt'));
    await assert.rejects(store.textFile(result,'escape.txt'));
  }
});
test('QQ companion: one model call, durable memory, group privacy, confirmed natural task and file retrieval', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const replies = [], contexts = []; let executions = 0;
  const onebot = createServer(async (req,res) => { let raw=''; for await(const c of req) raw+=c; replies.push(JSON.parse(raw)); res.end('{"status":"ok","retcode":0}'); });
  await new Promise(r=>onebot.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>onebot.close(r)));
  const config = loadConfig({ ADMIN_TOKEN:'a'.repeat(40),ONEBOT_SECRET:'b'.repeat(40),ONEBOT_TOKEN:'c'.repeat(40),ALLOWED_USERS:'101,102',ALLOWED_GROUPS:'201',MODEL_BACKEND:'codex',ENABLE_CODEX_WORK:'true',REPLY_DELAY_MS:'0',ONEBOT_URL:`http://127.0.0.1:${onebot.address().port}`,DATA_DIR:join(dir,'data'),WORKSPACE_DIR:join(dir,'workspace') });
  const options = {
    model:async(_,history,context) => {
      contexts.push(context);
      const text=history.at(-1).content;
      return { reply:text==='long' ? '🙂正文'.repeat(2000) : '原样回复', memories:text==='我喜欢猫'?[{label:'hobby',text:'用户喜欢猫'}]:[], task:text==='帮我写代码'?{summary:'编写示例',prompt:'生成hello.txt'}:null };
    },
    worker:async(_,prompt,cwd)=>{executions++; await writeFile(join(cwd,'hello.txt'),'任务文件正文'); return '已生成hello.txt';},
    logger:{error(){}},
  };
  let app=await createApp(config,options); await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{if(app.server.listening) await app.close();});
  let id=0;
  async function post(text, group=false, user=101) {
    const event={post_type:'message',message_type:group?'group':'private',self_id:999,user_id:user,message_id:++id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}],...(group?{group_id:201}: {})};
    if(group)event.message.push({type:'at',data:{qq:999}});
    const raw=JSON.stringify(event);
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',config.onebotSecret).update(raw).digest('hex')}`},body:raw});
    assert.equal(response.status,200); await app.idle();
    return replies.at(-1).message[0].data.text;
  }
  await post('我喜欢猫'); assert.equal(contexts.length,1);
  await app.close(); app=await createApp(config,options); await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  await post('你好'); assert.equal(contexts.at(-1).facts[0].text,'用户喜欢猫');
  await post('群聊你好',true); assert.deepEqual(contexts.at(-1).facts,[]);
  await post('/重置'); await post('你好'); assert.equal(contexts.at(-1).facts.length,1);
  await post('/自动记忆 关'); await post('我喜欢猫'); assert.equal(contexts.at(-1).automatic,false);
  await post('/清空记忆'); await post('你好'); assert.deepEqual(contexts.at(-1).facts,[]);
  await post('帮我写代码'); assert.equal(executions,0);
  const token=replies.at(-1).message[0].data.text.match(/确认 ([a-f0-9]+)/)[1];
  assert.match(await post(`/确认 ${token}`,false,102),/无效/);
  const answer=await post(`/确认 ${token}`); assert.equal(executions,1);
  const job=answer.match(/任务 ([a-f0-9]{24})/)[1];
  assert.match(await post(`/结果 ${job}`),/hello.txt/);
  assert.equal(await post(`/文件 ${job} hello.txt`),'任务文件正文');
  assert.match(await post(`/文件 ${job} hello.txt`,true),/不可访问/);
  const before=replies.length;
  await post('long');
  assert.equal(replies.slice(before).map(x=>x.message[0].data.text.replace(/^【\d+\/\d+】\n/,'')).join(''),'🙂正文'.repeat(2000));
});
