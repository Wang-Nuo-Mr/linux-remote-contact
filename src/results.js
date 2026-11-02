import { mkdir, readFile, writeFile, rename, lstat, realpath, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';

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
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
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
}
