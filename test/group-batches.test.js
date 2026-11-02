import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory.js';

test('busy-group batching preserves every speaker, limits memory subjects and keeps command boundaries', async t => {
  const dir=await mkdtemp(join(tmpdir(),'contact-batch-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const identity=join(dir,'identity.json');
  await writeFile(identity,JSON.stringify({creator:{qq:'10001',name:'创造者'},groups:[{id:'20001',members:['10001','10002','10003'].map(qq=>({qq,name:qq}))}]}));
  const onebot=createServer((_,res)=>res.end('{"status":"ok","retcode":0}'));
  await new Promise(r=>onebot.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>onebot.close(r)));
  const config=loadConfig({ADMIN_TOKEN:'a'.repeat(40),ONEBOT_SECRET:'b'.repeat(40),ONEBOT_TOKEN:'c'.repeat(40),MODEL_BACKEND:'codex',ALLOWED_USERS:'10001',ALLOWED_GROUPS:'20001',COMPANION_IDENTITY_FILE:identity,DATA_DIR:join(dir,'data'),WORKSPACE_DIR:join(dir,'workspace'),ONEBOT_URL:`http://127.0.0.1:${onebot.address().port}`,GROUP_DEBOUNCE_MS:'0'});
  const calls=[];let release,entered;
  let gate,started;
  function latch(){gate=new Promise(r=>{release=r;});started=new Promise(r=>{entered=r;});}
  latch();
  const app=await createApp(config,{model:async(_,history,context)=>{
    const text=JSON.parse(history.at(-1).content).text;
    calls.push(structuredClone(context));
    if(text==='hold'){entered();await gate;return {shouldReply:false,reply:'',memories:[],task:null};}
    return {shouldReply:false,reply:'',task:null,memories:[...context.group.newMessages.map(m=>({subject:m.speaker.qq,label:'preference',text:m.text})),{subject:'10001',label:'forged',text:'不可替未发言的人记录'}]};
  },logger:{error(){}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  let id=0;
  async function post(user,text){
    const raw=JSON.stringify({post_type:'message',message_type:'group',group_id:20001,self_id:99999,user_id:Number(user),message_id:++id,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]});
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',config.onebotSecret).update(raw).digest('hex')}`},body:raw});assert.equal(response.status,200);
  }
  await post('10001','hold');await started;
  await post('10002','我喜欢猫');await post('10003','我喜欢音乐');release();await app.idle();
  assert.equal(calls.length,2);assert.equal(calls.at(-1).group.newMessages.length,2);
  const store=new MemoryStore(config.dataDir);
  assert.equal((await store.get('group:20001:10002')).facts[0].text,'我喜欢猫');
  assert.equal((await store.get('group:20001:10003')).facts[0].text,'我喜欢音乐');
  assert.deepEqual((await store.get('group:20001:10001')).facts,[]);
  latch();await post('10001','hold');await started;
  await post('10002','命令之前');await post('10002','/记住 边界记忆');await post('10003','命令之后');release();await app.idle();
  assert.equal(calls.length,5);
  assert.deepEqual(calls.at(-2).group.newMessages.map(m=>m.text),['命令之前']);
  assert.deepEqual(calls.at(-1).group.newMessages.map(m=>m.text),['命令之后']);
  assert.ok(calls.at(-1).group.participants.find(m=>m.qq==='10002').facts.some(f=>f.text==='边界记忆'));
});
