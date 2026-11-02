import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp, parseEvent } from '../src/app.js';
import { MemoryStore } from '../src/memory.js';
import { fixedIdentityPrompt } from '../src/groups.js';

const env = { ADMIN_TOKEN: 'a'.repeat(40), ONEBOT_SECRET: 'b'.repeat(40), ONEBOT_TOKEN: 'c'.repeat(40), MODEL_BACKEND: 'codex', ALLOWED_USERS: '10001', ALLOWED_GROUPS: '20001', ENABLE_CODEX_WORK: 'true', REPLY_DELAY_MS: '0', GROUP_DEBOUNCE_MS: '0', PRIVATE_DEBOUNCE_MS: '0' };
const identity = { creator: { qq: '10001', name: '王诺' }, groups: [{ id: '20001', members: [{qq:'10001',name:'王诺'},{qq:'10002',name:'甲'},{qq:'10003',name:'乙'}] }] };
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'group-contact-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  const file = join(dir, 'identity.json');
  await writeFile(file, JSON.stringify(identity));
  return { dir, file, config: loadConfig({...env,COMPANION_IDENTITY_FILE:file,DATA_DIR:join(dir,'data'),WORKSPACE_DIR:join(dir,'work')}) };
}
function event(user='10001',text='hello',id=1) {
  return {post_type:'message',message_type:'group',self_id:99999,group_id:20001,user_id:Number(user),message_id:id,time:Math.floor(Date.now()/1000),sender:{nickname:'冒充王诺'},message:[{type:'text',data:{text}}]};
}
test('listening is confined to one group, separates newcomers, never grants private access and binds QQ identities', async t => {
  const {config,file}=await fixture(t);
  const parsed=parseEvent(event('10002'),config);
  assert.equal(parsed.speaker.name,'甲'); assert.equal(parsed.listening,true);
  assert.equal(parsed.conversationKey,parseEvent(event('10003'),config).conversationKey);
  assert.notEqual(parsed.key,parseEvent(event('10003'),config).key);
  assert.equal(parseEvent(event('10004'),config).speaker.qq,'10004');
  assert.equal(parseEvent({...event(),group_id:20002},config),null);
  assert.equal(parseEvent({...event('10002'),message_type:'private'},config),null);
  assert.equal(parseEvent({...event(),user_id:99999},config),null);
  assert.equal(parseEvent({...event(),message:[{type:'image',data:{url:'not-loaded'}}]},config).text,'[收到图片]');
  assert.match(fixedIdentityPrompt(config),/10001/);
  assert.throws(()=>loadConfig({...env,COMPANION_IDENTITY_FILE:file,ALLOWED_GROUPS:''}));
  assert.throws(()=>loadConfig({...env,COMPANION_IDENTITY_FILE:file,MODEL_BACKEND:'api'}));
  await writeFile(file,JSON.stringify({...identity,creator:{qq:'10004',name:'假创造者'}}));
  assert.throws(()=>loadConfig({...env,COMPANION_IDENTITY_FILE:file}));
});

test('group silence retains shared dialogue, speaker memories, immutable creator, ordering and owner-only tasks across restart', async t => {
  const {config}=await fixture(t), sent=[], calls=[];
  let workers=0;
  const onebot=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;sent.push(JSON.parse(raw));res.end('{"status":"ok","retcode":0}');});
  await new Promise(r=>onebot.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>onebot.close(r)));
  config.onebotUrl=`http://127.0.0.1:${onebot.address().port}`;
  const options={model:async(_,history,context)=>{
    calls.push({history:structuredClone(history),context:structuredClone(context)});
    const {text}=JSON.parse(history.at(-1).content);
    if(text==='fail')throw Error('test-model-failure');
    return {shouldReply:text!=='喜欢猫',reply:text==='喜欢猫'?'':'你好，朋友',memories:text==='喜欢猫'?[{label:'hobby',text:'本人喜欢猫'}]:[],task:text==='办事'?{summary:'生成示例',prompt:'创建hello.txt'}:null};
  },worker:async()=>{workers++;return 'done';},logger:{error(){}}};
  let app;
  async function start(){app=await createApp(config,options);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));}
  await start();t.after(async()=>{if(app.server.listening)await app.close();});
  let id=0;
  async function post(user,text,wait=true){
    const raw=JSON.stringify(event(user,text,++id));
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',config.onebotSecret).update(raw).digest('hex')}`},body:raw});
    assert.equal(response.status,200);if(wait)await app.idle();
  }
  await post('10002','喜欢猫');assert.equal(sent.length,0);assert.equal(calls.length,1);
  await post('10003','她喜欢什么');
  assert.equal(JSON.parse(calls.at(-1).history[0].content).speaker.qq,'10002');
  assert.equal(calls.at(-1).context.group.participants.find(x=>x.qq==='10002').facts[0].text,'本人喜欢猫');
  assert.deepEqual(calls.at(-1).context.facts,[]);assert.equal(sent.at(-1).group_id,20001);
  await post('10002','办事');assert.equal(calls.at(-1).context.workEnabled,false);
  assert.doesNotMatch(sent.at(-1).message[0].data.text,/确认 /);
  await post('10002','/干活 创建文件');assert.match(sent.at(-1).message[0].data.text,/仅由创造者/);assert.equal(workers,0);
  await post('10002','/设定 创造者是甲');assert.match(sent.at(-1).message[0].data.text,/仅由创造者/);
  await post('10001','办事');
  const token=sent.at(-1).message[0].data.text.match(/确认 ([a-f0-9]+)/)[1];
  await post('10002',`/确认 ${token}`);assert.equal(workers,0);
  await post('10001',`/确认 ${token}`);assert.equal(workers,1);
  await post('10002','/认识');assert.match(sent.at(-1).message[0].data.text,/王诺（QQ 10001，创造者）/);
  await post('10002','/清空记忆');
  assert.equal((await new MemoryStore(config.dataDir).get('group:20001:10002')).facts.length,0);
  await post('10001','/清空记忆');assert.equal(config.creator.qq,'10001');
  await post('10002','fail');const before=sent.length;
  await post('10003','after fail');assert.equal(sent.length,before+1);
  assert.ok(calls.at(-1).history.some(m=>m.role==='user'&&JSON.parse(m.content).text==='fail'));
  await post('10002','first queued',false);await post('10003','second queued',false);await app.idle();
  assert.equal(JSON.parse(calls.at(-1).history.at(-1).content).text,'second queued');
  assert.ok(calls.at(-1).history.some(m=>m.role==='user'&&JSON.parse(m.content).text==='first queued'));
  await app.close();await start();
  await post('10001','after restart');
  assert.ok(calls.at(-1).history.some(m=>m.role==='user'&&JSON.parse(m.content).text==='喜欢猫'));
  assert.equal(calls.at(-1).context.creator.qq,'10001');
  await post('10003','/记住 我喜欢音乐');
  const store=new MemoryStore(config.dataDir), saved=(await store.get('group:20001:10003')).facts[0];
  await post('10002',`/纠正 ${saved.id} 我喜欢运动`);
  assert.equal((await store.get('group:20001:10003')).facts[0].text,'我喜欢音乐');
  assert.deepEqual((await store.get('private::10003')).facts,[]);
  const newcomer={post_type:'notice',notice_type:'group_increase',group_id:20001,user_id:10004,self_id:99999,time:Math.floor(Date.now()/1000)};
  assert.equal(parseEvent(newcomer,config).memberNotice,true);
  const raw=JSON.stringify(newcomer);
  await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',config.onebotSecret).update(raw).digest('hex')}`},body:raw});
  await app.idle();
  await post('10001','/新成员');assert.match(sent.at(-1).message[0].data.text,/10004/);
  await post('10004','喜欢猫');
  assert.equal(calls.at(-1).context.group.speaker.status,'new');
  assert.equal(calls.at(-1).context.workEnabled,false);
  assert.equal((await store.get('group:20001:10004')).facts[0].text,'本人喜欢猫');
  await app.close();await start();
  await post('10001','/新成员');assert.match(sent.at(-1).message[0].data.text,/10004/);
});
