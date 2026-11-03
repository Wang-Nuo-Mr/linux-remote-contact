import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, relative, isAbsolute, basename, extname } from 'node:path';

export class Results {
  constructor(dataDir, workspace) { this.dir = join(dataDir, 'results'); this.workspace = workspace; }
  path(id) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid result ID');
    return join(this.dir, `${id}.json`);
  }
  async put(result) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(result.id);
    await writeFile(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async create(key, summary) {
    const id = randomBytes(12).toString('hex');
    const scope = createHash('sha256').update(key).digest('hex');
    const cwd = join(this.workspace, scope, id);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    const result = { id, key, summary, status: 'running', cwd, createdAt: new Date().toISOString(), output: '' };
    await this.put(result);
    return result;
  }
  async get(key, id) {
    const result = JSON.parse(await readFile(this.path(id), 'utf8'));
    if (result.key !== key) throw new Error('Result not in current conversation');
    return result;
  }
  async files(result) {
    const names = [];
    async function walk(path, prefix = '', depth = 0) {
      if (depth > 5 || names.length >= 100) return;
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'inputs') continue;
        const name = prefix + entry.name;
        if (entry.isFile()) names.push(name);
        else if (entry.isDirectory()) await walk(join(path, entry.name), name + '/', depth + 1);
        if (names.length >= 100) break;
      }
    }
    await walk(result.cwd);
    return names;
  }
  async textFile(result, name) {
    const root = await realpath(result.cwd);
    const path = resolve(root, name);
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path outside result');
    const canonical = await realpath(path);
    const canonicalRel = relative(root, canonical);
    if (canonicalRel.startsWith('..') || isAbsolute(canonicalRel)) throw new Error('Symlink outside result');
    const info = await lstat(canonical);
    if (!info.isFile() || info.size > 64000) throw new Error('Only text files up to 64 KB can be viewed');
    const data = await readFile(canonical);
    if (data.includes(0)) throw new Error('Not a text file');
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  }
  async attachment(result, name, limit = 20 * 1024 * 1024) {
    if (typeof name !== 'string' || name.length > 240 || name.split(/[\\/]/).some(x => !x || x.startsWith('.') || x === 'inputs')) throw new Error('Invalid artifact path');
    const root = await realpath(result.cwd), path = resolve(root, name), rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path outside result');
    const canonical = await realpath(path);
    if (relative(root, canonical) !== rel) throw new Error('Artifact symlink not allowed');
    for (let current = root, parts = rel.split(/[\\/]/); parts.length;) {
      current = join(current, parts.shift());
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Artifact symlink not allowed');
    }
    const allowed = new Set(['.docx','.pptx','.xlsx','.pdf','.png','.jpg','.jpeg','.webp','.gif','.svg','.csv','.txt','.md','.json','.py','.js','.ts','.html','.css','.zip']);
    if (!allowed.has(extname(path).toLowerCase())) throw new Error('File type not deliverable');
    const info = await lstat(canonical);
    if (!info.isFile() || info.size < 1 || info.size > limit) throw new Error('Artifact exceeds file limit');
    const data = await readFile(canonical);
    if (data.length > limit) throw new Error('Artifact changed size');
    return { name: basename(path), data };
  }
  async list(key, limit = 10) {
    const items = [];
    try {
      for (const name of (await readdir(this.dir)).filter(x => /^[a-f0-9]{24}\.json$/.test(x))) {
        const value = JSON.parse(await readFile(join(this.dir,name),'utf8'));
        if (value.key === key) items.push(value);
      }
    } catch(error) { if(error.code !== 'ENOENT') throw error; }
    return items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,limit);
  }
  async recover() {
    try {
      for (const name of (await readdir(this.dir)).filter(x => /^[a-f0-9]{24}\.json$/.test(x))) {
        const value = JSON.parse(await readFile(join(this.dir,name),'utf8'));
        if (value.kind === 'artifact' && ['queued','running'].includes(value.status)) {
          value.status = 'interrupted'; value.stage = '服务重启，未自动重跑'; await this.put(value);
        }
      }
    } catch(error) { if(error.code !== 'ENOENT') throw error; }
  }
}
