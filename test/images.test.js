import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { prepareImages, qqImageUrl } from '../src/images.js';
import { createApp, parseEvent } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { invokeCodex } from '../src/model.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8b8AAAAASUVORK5CYII=', 'base64');
const config = { backend: 'codex' };
const message = (user, url = 'https://multimedia.nt.qq.com.cn/download?token=private') => ({ user, imageRefs: [{url}] });

test('QQ image transport restricts hosts, paths, redirects, sizes and formats; cleans temporary files', async () => {
  assert.match(qqImageUrl('http://gchat.qpic.cn/a'), /^https:/);
  for (const url of ['https://qpic.cn.evil.test/a', 'file:///etc/passwd', 'http://127.0.0.1/a', 'https://a:q@qpic.cn/a', 'https://qpic.cn:7890/a']) assert.throws(() => qqImageUrl(url));
  let calls=0;
  const input=await prepareImages(config,[message('1'),message('2')],{fetcher:async (url, options)=>{
    calls++; assert.equal(options.redirect,'error'); assert.equal(options.headers,undefined); return new Response(png);
  }});
  try {
    assert.equal(calls,2); assert.deepEqual(input.attachments.map(x=>[x.senderQQ,x.attachment]),[['1',1],['2',2]]);
    assert.deepEqual(await readFile(input.paths[0]),png);
    assert.ok(!JSON.stringify(input.attachments).includes('token'));
  } finally { await input.cleanup(); }
  await assert.rejects(stat(input.paths[0]),{code:'ENOENT'});
  for (const response of [()=>new Response('<svg/>'),()=>new Response(png,{headers:{'content-length':String(9*1024*1024)}}),()=>new Response(png,{status:403})]) {
    const bad=await prepareImages(config,[message('1')],{fetcher:async()=>response()});
    assert.deepEqual(bad.paths,[]);assert.equal(bad.attachments[0].status,'unavailable');await bad.cleanup();
  }
  let resolved=0;
  const forbidden=await prepareImages(config,[{user:'1',imageRefs:[{file:'../../.codex/auth.json'}]}],{resolve:async()=>{resolved++;}});
  assert.equal(resolved,0); assert.deepEqual(forbidden.paths,[]); await forbidden.cleanup();
  const fallback=await prepareImages(config,[{user:'2',imageRefs:[{file:'abc123.jpg'}]}],{resolve:async(_,action,params)=>{
    assert.equal(action,'get_image');assert.equal(params.file,'abc123.jpg');return {url:'http://gchat.qpic.cn/image',file:'/should/not/read'};
  },fetcher:async()=>new Response(png)});
  assert.equal(fallback.paths.length,1);await fallback.cleanup();
  calls=0;
  const bounded=await prepareImages(config,Array.from({length:10},()=>message('1')),{fetcher:async()=>{calls++;throw new Error('offline');}});
  assert.equal(calls,4);assert.equal(bounded.attachments.at(-1).reason,'batch_limit');await bounded.cleanup();
  const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
  const animated=await prepareImages(config,[message('2')],{fetcher:async()=>new Response(gif),convertGif:async(source,dest)=>{assert.deepEqual(await readFile(source),gif);await writeFile(dest,png);}});
  try{assert.match(animated.paths[0],/\.png$/);assert.equal(animated.attachments[0].representation,'gif_first_frame');}finally{await animated.cleanup();}
});

test('real signed webhook attaches images with speaker mapping, excludes download tokens from history and cleans after model errors', async t => {
  const dir=await mkdtemp(join(tmpdir(),'contact-images-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await writeFile(join(dir,'identity.json'),JSON.stringify({creator:{qq:'10001',name:'王诺'},groups:[{id:'20001',members:[{qq:'10001',name:'王诺'},{qq:'10002',name:'群友'}]}]}));
  const bot=createServer((_,res)=>res.end('{"status":"ok","retcode":0}'));await new Promise(r=>bot.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>bot.close(r)));
  const settings=loadConfig({PRIVATE_DEBOUNCE_MS:'0',ADMIN_TOKEN:'a'.repeat(40),ONEBOT_SECRET:'b'.repeat(40),ONEBOT_TOKEN:'c'.repeat(40),MODEL_BACKEND:'codex',ALLOWED_USERS:'10001',ALLOWED_GROUPS:'20001',COMPANION_IDENTITY_FILE:join(dir,'identity.json'),DATA_DIR:join(dir,'data'),WORKSPACE_DIR:join(dir,'work'),ONEBOT_URL:`http://127.0.0.1:${bot.address().port}`,GROUP_DEBOUNCE_MS:'100'});
  let paths=[],calls=0;
  const app=await createApp(settings,{imageLoader:(c,m)=>prepareImages(c,m,{fetcher:async()=>new Response(png)}),model:async(_,history,context,options)=>{
    calls++;paths=options.images;assert.ok(paths.length>0);for(const path of paths)await stat(path);
    assert.ok(!JSON.stringify({history,context}).includes('token=private'));
    if(calls===1){assert.deepEqual(context.imageAttachments.map(x=>x.senderQQ),['10001','10002']);throw new Error('model offline');}
    return {shouldReply:true,reply:'看到了图片',memories:[],task:null};
  },logger:{error(){}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.close());
  let id=0;
  const event=(user,group)=>({post_type:'message',message_type:group?'group':'private',group_id:group,self_id:99999,user_id:user,message_id:++id,time:Math.floor(Date.now()/1000),message:[{type:'image',data:message(String(user)).imageRefs[0]}]});
  const privateEvent=event(10001);assert.ok(parseEvent(privateEvent,settings));assert.equal(parseEvent({...privateEvent,user_id:33333},settings),null);
  async function post(data){const raw=JSON.stringify(data);const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/onebot/event`,{method:'POST',headers:{'x-signature':`sha1=${createHmac('sha1',settings.onebotSecret).update(raw).digest('hex')}`},body:raw});assert.equal(res.status,200);}
  await post(event(10001,20001));await post(event(10002,20001));await app.idle();assert.equal(calls,1);
  for(const path of paths) await assert.rejects(stat(path),{code:'ENOENT'});
  await post(privateEvent);await app.idle();assert.equal(calls,2);
  for(const path of paths) await assert.rejects(stat(path),{code:'ENOENT'});
  for(const file of await readdir(settings.dataDir)) if(file.endsWith('.json')) assert.ok(!(await readFile(join(settings.dataDir,file),'utf8')).includes('token=private'));
});

test('Linux Codex adapter passes readable image files using --image', {skip:process.platform==='win32'}, async t=>{
  const dir=await mkdtemp(join(tmpdir(),'contact-cli-images-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const image=join(dir,'fixture.png'),stub=join(dir,'codex');await writeFile(image,png);
  await writeFile(stub,`#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const i=args.indexOf('--image');
if(i<0||!fs.readFileSync(args[i+1]).subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))process.exit(2);
if(args.at(-1)!=='-'||args[args.indexOf('--sandbox')+1]!=='read-only')process.exit(3);
process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'image received'));
`,{mode:0o700});
  assert.equal(await invokeCodex({codexBin:stub,workspace:dir,timeout:5000},'看图',{images:[image]}),'image received');
});
