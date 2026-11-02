import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpeechService, MusicService, UsageBudget, loadMediaConfig, aliyunAudioUrl, voiceInstruction } from '../src/media.js';

function wav() { const value=Buffer.alloc(100);value.write('RIFF');value.write('WAVE',8);return value; }
const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
test('voice configuration supports the selected Qwen voice, validates endpoints and keeps signed audio download separate',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'voice-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const file=join(dir,'voice.json'),input={apiKey:'test-only-key-value-123456789',model:'qwen-audio-3.0-tts-plus',voiceId:'qwen-audio-3.0-tts-plus-vd-demo-abc',baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com'};
  await writeFile(file,JSON.stringify(input));assert.equal(loadMediaConfig(file,'voice').model,input.model);
  await writeFile(file,JSON.stringify({...input,baseUrl:'https://attacker.example'}));assert.throws(()=>loadMediaConfig(file,'voice'));
  assert.throws(()=>aliyunAudioUrl('http://127.0.0.1/secret'));
  assert.throws(()=>aliyunAudioUrl('https://example.com/result.wav'));
  assert.match(aliyunAudioUrl('http://result.oss-cn-beijing.aliyuncs.com/result.wav?signature=private'),/^https:/);
  assert.ok([...voiceInstruction('轻快含笑'.repeat(30))].reduce((n,c)=>n+(/[\u3400-\u9fff]/.test(c)?2:1),0)<=100);
});
test('speech preserves source text, carries emotional direction and never forwards API credentials to audio downloads',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'speech-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls=[],config={enabled:true,apiKey:'private-test-key',baseUrl:'https://workspace.cn-beijing.maas.aliyuncs.com',model:'qwen-audio-3.0-tts-plus',voiceId:'voice-demo',dailyCharacters:100,maxCharacters:80};
  const service=new SpeechService(config,new UsageBudget(dir),{fetcher:async(url,options)=>{
    calls.push({url,options});
    if(url.includes('SpeechSynthesizer'))return json({output:{audio:{url:'http://result.oss-cn-beijing.aliyuncs.com/test.wav?signature=not-for-model'}}});
    assert.equal(options.headers,undefined);return new Response(wav());
  }});
  const text='嗯……慢慢来，我在听。';assert.deepEqual(await service.synthesize(text,'温柔安慰'),wav());
  const body=JSON.parse(calls[0].options.body);assert.equal(body.input.text,text);assert.match(body.input.instruction,/温柔安慰/);assert.equal(body.model,config.model);
  assert.equal(calls[0].options.headers.Authorization,'Bearer private-test-key');assert.match(calls[1].url,/^https:/);
  const failing=new SpeechService(config,new UsageBudget(dir),{fetcher:async()=>new Response('private-test-key',{status:401})});
  await assert.rejects(failing.synthesize('测试'),error=>!error.message.includes(config.apiKey));
});
test('daily budgets serialize concurrent calls, survive restart and stop additional spending',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'budget-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const budget=new UsageBudget(dir);
  const results=await Promise.allSettled([budget.reserve('voiceCharacters',7,10),budget.reserve('voiceCharacters',7,10)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  await assert.rejects(new UsageBudget(dir).reserve('voiceCharacters',4,10));
  await new UsageBudget(dir).reserve('voiceCharacters',3,10);
});
test('music uses its own credential and service, enforces allowance and returns audio without pretending voice identity',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'music-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const bytes=Buffer.from('ID3song-demo');
  const service=new MusicService({enabled:true,baseUrl:'https://api.minimax.cn',apiKey:'music-key',dailySongs:1},new UsageBudget(dir),{fetcher:async(url,options)=>{
    assert.equal(url,'https://api.minimax.cn/v1/music_generation');assert.equal(options.headers.Authorization,'Bearer music-key');
    const body=JSON.parse(options.body);assert.equal(body.lyrics,'原创测试歌词');assert.equal(body.model,'music-3.0');
    return json({base_resp:{status_code:0},data:{audio:bytes.toString('hex')}});
  }});
  assert.deepEqual(await service.generate('温柔的短歌','原创测试歌词'),bytes);
  await assert.rejects(service.generate('温柔的短歌','原创测试歌词'));
  await assert.rejects(new MusicService({enabled:false},new UsageBudget(dir)).generate('test','test'));
});
