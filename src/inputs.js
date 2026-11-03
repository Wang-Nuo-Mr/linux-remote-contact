import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm, copyFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { onebot } from './social.js';
import { limitedBody } from './media.js';
import { runProcess } from './tasks.js';
import { fileURLToPath } from 'node:url';

const extensions = new Set(['docx','pptx','xlsx','pdf','txt','md','csv','json']);
export function fileReferences(segments) {
  return segments.filter(x=>x.type==='file').slice(0,3).map(x=>({name:String(x.data?.name||x.data?.file_name||(typeof x.data?.file==='string'&&!/^(https?:|file:|base64:)/i.test(x.data.file)?x.data.file:'文件')).slice(0,120),id:String(x.data?.file_id||x.data?.id||x.data?.file||'').slice(0,256),url:typeof x.data?.url==='string'?x.data.url.slice(0,8192):'',size:Number(x.data?.file_size||x.data?.size)||0,busid:Number(x.data?.busid)||0}));
}
export function inputUrl(value) {
  const url = new URL(value);
  if (!['qq.com','qq.com.cn','qpic.cn'].some(x=>url.hostname===x||url.hostname.endsWith('.'+x)) || !['https:','http:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length>8192) throw new Error('Untrusted QQ file URL');
  url.protocol='https:';return url.href;
}
function safeName(value) { return value.replace(/[\\/\x00-\x1f]/g,'_').slice(0,120); }
export class InputStore {
  constructor(config,{api=onebot,fetcher=fetch,extractor=runProcess}={}){this.config=config;this.root=join(config.dataDir,'inputs');this.api=api;this.fetcher=fetcher;this.extractor=extractor;}
  dir(key){return join(this.root,createHash('sha256').update(key).digest('hex'));}
  async list(key){
    const dir=this.dir(key),items=[];
    try{for(const name of await readdir(dir)){if(!/^[a-f0-9]{24}\.json$/.test(name))continue;const data=JSON.parse(await readFile(join(dir,name),'utf8'));if(data.key===key)items.push(data);}}
    catch(e){if(e.code!=='ENOENT')throw e;}
    return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async receive(event,ref){
    const name=safeName(ref.name),extension=extname(name).slice(1).toLowerCase();
    if(!extensions.has(extension))throw new Error('Unsupported input file type');
    if(ref.size>10*1024*1024)throw new Error('Input file exceeds 10 MB');
    const dir=this.dir(event.key);await mkdir(dir,{recursive:true,mode:0o700});
    let existing=await this.list(event.key);
    // Expire only this feature's own imported cache, never chat memory or results.
    for(const item of existing.filter(x=>Date.now()-Date.parse(x.createdAt)>7*86400000)){
      if(!/^[a-f0-9]{24}$/.test(item.id))continue;
      for(const suffix of ['.json','.blob.'+item.extension,'.extracted.json'])await rm(join(dir,item.id+suffix),{force:true});
    }
    existing=existing.filter(x=>Date.now()-Date.parse(x.createdAt)<=7*86400000);
    if(existing.length>=10)throw new Error('Input cache full');
    let url,data;
    const validId=typeof ref.id==='string'&&/^[a-zA-Z0-9_{}][a-zA-Z0-9_{}+./=~-]{0,255}$/.test(ref.id)&&!ref.id.includes('..');
    try {
    try{url=inputUrl(ref.url);}catch{
      // File IDs may contain slash/base64 separators. They go only to the
      // authenticated QQ URL resolver, never to a filesystem or fetch directly.
      if(!validId)throw new Error('Invalid QQ file ID');
      const resolved=await this.api(this.config,event.type==='group'?'get_group_file_url':'get_private_file_url',{...(event.type==='group'?{group_id:Number(event.group),busid:ref.busid}:{user_id:Number(event.user)}),file_id:ref.id},{timeout:20000});
      url=inputUrl(resolved?.url);
    }
    const response=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error('QQ file download failed');
    if(Number(response.headers.get('content-length'))>10*1024*1024){await response.body?.cancel();throw new Error('Input too large');}
    data=await limitedBody(response,10*1024*1024);
    } catch(error) {
      // Some QQ file URLs use raw HTTP IPs. Do not fetch arbitrary IPs or local
      // paths: ask the authenticated OneBot cache for bounded bytes instead.
      if(!validId||ref.id.length<20)throw error;
      const cached=await this.api(this.config,'get_file',{file_id:ref.id},{timeout:60000,limit:15*1024*1024});
      const encoded=cached?.base64;
      if(typeof encoded!=='string'||!encoded||encoded.length>14*1024*1024||!/^[a-zA-Z0-9+/=\r\n]+$/.test(encoded))throw new Error('QQ cached file bytes unavailable');
      data=Buffer.from(encoded,'base64');
      if(data.length>10*1024*1024)throw new Error('Input too large');
    }
    if(!data.length||existing.reduce((sum,x)=>sum+x.size,0)+data.length>60*1024*1024)throw new Error('Input cache size limit');
    const digest=createHash('sha256').update(data).digest('hex');
    const previous=existing.find(x=>x.sha256===digest);if(previous)return previous;
    const id=randomBytes(12).toString('hex'),stored=join(dir,id+'.blob.'+extension),extracted=join(dir,id+'.extracted.json');
    await writeFile(stored,data,{mode:0o600});
    try{
      const run=await this.extractor(this.config.artifactPython||'python3',[this.config.artifactRenderer||fileURLToPath(new URL('../tools/artifacts/render.py',import.meta.url)),'extract',stored,extension,extracted],{cwd:dir,timeout:45000,limit:4000});
      if(run.code!==0||run.timedOut||run.truncated)throw new Error('File extraction failed');
      const content=JSON.parse(await readFile(extracted,'utf8'));
      if(typeof content.text!=='string'||content.text.length>60000)throw new Error('Invalid extracted text');
      const metadata={id,key:event.key,name,extension,size:data.length,sha256:digest,createdAt:new Date().toISOString(),truncated:Boolean(content.truncated),scanMayNeedOCR:Boolean(content.scanMayNeedOCR)};
      await writeFile(join(dir,id+'.json.tmp'),JSON.stringify(metadata),{mode:0o600});await rename(join(dir,id+'.json.tmp'),join(dir,id+'.json'));
      return metadata;
    }catch(error){await rm(stored,{force:true});await rm(extracted,{force:true});throw error;}
  }
  async context(key,ids=[]){
    const items=(await this.list(key)).filter(x=>Date.now()-Date.parse(x.createdAt)<=7*86400000);
    const selected=ids.length?items.filter(x=>ids.includes(x.id)):items.slice(0,2);
    const result=[];
    for(const item of selected){const content=JSON.parse(await readFile(join(this.dir(key),item.id+'.extracted.json'),'utf8'));result.push({id:item.id,name:item.name,text:content.text.slice(0,18000),truncated:item.truncated||content.text.length>18000,scanMayNeedOCR:item.scanMayNeedOCR});}
    return result;
  }
  async forget(key,id){
    if(!/^[a-f0-9]{24}$/.test(id))throw new Error('Invalid input ID');
    const item=(await this.list(key)).find(x=>x.id===id);if(!item)throw new Error('Input not owned');
    for(const suffix of ['.json','.blob.'+item.extension,'.extracted.json'])await rm(join(this.dir(key),id+suffix),{force:true});
  }
  async copyTo(key,cwd){
    const items=(await this.list(key)).filter(x=>Date.now()-Date.parse(x.createdAt)<=7*86400000).slice(0,2),copied=[];
    if(items.length)await mkdir(join(cwd,'inputs'),{recursive:true,mode:0o700});
    for(const [index,item] of items.entries()){
      if(!/^[a-f0-9]{24}$/.test(item.id)||!extensions.has(item.extension))throw new Error('Invalid input metadata');
      const name=`inputs/source-${index+1}.${item.extension}`;await copyFile(join(this.dir(key),item.id+'.blob.'+item.extension),join(cwd,name));copied.push({file:name,name:item.name});
    }
    return copied;
  }
}
