import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory.js';

const env={ADMIN_TOKEN:'a'.repeat(40),ONEBOT_SECRET:'b'.repeat(40),ONEBOT_TOKEN:'c'.repeat(40),ALLOWED_USERS:'10001,10002',MODEL_BACKEND:'codex',PRIVATE_DEBOUNCE_MS:'160',GROUP_DEBOUNCE_MS:'0',CHAT_MAX_WAIT_MS:'600'};
async function fixture(t,overrides={},model){
  const dir=await mkdtemp(join(tmpdir(),'contact-debounce-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sent=[];
  const bot=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;sent.push(JSON.parse(raw));res.end('{"status":"ok","retcode":0}');});
  await new Promise(r=>bot.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>bot.close(r)));
  const config=loadConfig({...env,...overrides,DATA_DIR:join(dir,'data'),WORKSPACE_DIR:join(dir,'workspace'),ONEBOT_URL:`http://127.0.0.1:${bot.address().port}`});
  const app=await createApp(config,{model,logger:{error(){}}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  let id=0;
  async function post(text,user=10001){
    const raw=JSON.stringify({post_type:'message',message_type:'private',self_id:99999,user_id:user,time:Math.floor(Date.now()/1000),message_id:++id,message:[{type:'text',data:{text}}]});
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',config.onebotSecret).update(raw).digest('hex')}`},body:raw});assert.equal(response.status,200);
  }
  return {app,config,sent,post};
}

test('private trailing debounce merges split sentences, resets on arrivals and remembers the entire turn',async t=>{
  const calls=[];let lastArrival;
  const {app,config,sent,post}=await fixture(t,{},async(_,history,context)=>{
    calls.push({at:Date.now(),context,history});
    return {reply:'合并回答',memories:context.turn.newMessages.map((m,i)=>({label:'preference'+i,text:m.text})),task:null};
  });
  await post('我喜欢猫');await delay(70);await post('也喜欢音乐');lastArrival=Date.now();await app.idle();
  assert.equal(calls.length,1);assert.ok(calls[0].at-lastArrival>=145);
  assert.deepEqual(calls[0].context.turn.newMessages.map(m=>m.text),['我喜欢猫','也喜欢音乐']);
  assert.equal(sent.length,1);
  assert.equal((await new MemoryStore(config.dataDir).get('private::10001')).facts.length,2);
});

test('maximum wait bounds continuous typing instead of postponing forever',async t=>{
  let started;const entered=new Promise(r=>{started=r;});const calls=[];
  const {app,post}=await fixture(t,{PRIVATE_DEBOUNCE_MS:'180',CHAT_MAX_WAIT_MS:'320'},async(_,history,context)=>{
    calls.push({at:Date.now(),messages:context.turn.newMessages});started();return {reply:'一次回答',memories:[],task:null};
  });
  const began=Date.now();await post('开头');
  for(let i=0;i<5;i++){await delay(40);await post('补充'+i);}
  const last=Date.now();await entered;await app.idle();
  assert.equal(calls.length,1);assert.equal(calls[0].messages.length,6);
  assert.ok(calls[0].at-began>=305);
  assert.ok(calls[0].at-last<170,'continuous messages should hit the max-wait deadline before the quiet window');
});

test('commands seal pending speech immediately, retain order and do not mix private users',async t=>{
  const calls=[];
  const {app,sent,post}=await fixture(t,{PRIVATE_DEBOUNCE_MS:'600',CHAT_MAX_WAIT_MS:'1000'},async(_,history,context)=>{
    calls.push(structuredClone(context));return {reply:context.turn.newMessages.map(m=>m.text).join('|'),memories:[],task:null};
  });
  await post('命令之前');await post('/记住 我喜欢详细解释');await post('命令之后');await post('另一个人的话',10002);await app.idle();
  assert.equal(calls.length,3);
  assert.deepEqual(calls.map(c=>c.turn.newMessages.map(m=>m.text)),[['命令之前'],['命令之后'],['另一个人的话']]);
  assert.ok(calls[1].facts.some(f=>f.text==='我喜欢详细解释'));
  assert.deepEqual(calls[2].facts,[]);
  assert.equal(sent[0].message[0].data.text,'命令之前');
  assert.match(sent[1].message[0].data.text,/已记住/);
});

test('debounce defaults and incompatible maximum-wait settings are explicit',()=>{
  const config=loadConfig({ADMIN_TOKEN:env.ADMIN_TOKEN,ONEBOT_SECRET:env.ONEBOT_SECRET,ONEBOT_TOKEN:env.ONEBOT_TOKEN});
  assert.equal(config.privateDebounce,3000);assert.equal(config.groupDebounce,4000);assert.equal(config.maxBatchWait,12000);
  assert.throws(()=>loadConfig({...env,CHAT_MAX_WAIT_MS:'100'}));
});
