import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const sensitive = /(?:密码|口令|密钥|验证码|身份证|银行卡|私钥|password|api[_ -]?key|access[_ -]?token|secret|-----BEGIN|sk-[\w-]{12,})/i;
export function containsSensitive(text) { return sensitive.test(String(text)); }
export function safeMemory(text) {
  return typeof text === 'string' && text.trim().length > 0 && text.length <= 400 && !sensitive.test(text);
}
export class MemoryStore {
  constructor(dataDir, automatic = true) { this.dir = join(dataDir, 'memories'); this.automatic = automatic; }
  path(key) { return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`); }
  async get(key) {
    try {
      const state = JSON.parse(await readFile(this.path(key), 'utf8'));
      if (!Array.isArray(state.facts) || typeof state.persona !== 'string' || typeof state.automatic !== 'boolean') throw new Error('Invalid memory state');
      return state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { facts: [], persona: '', automatic: this.automatic };
    }
  }
  async put(key, state) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(key);
    await writeFile(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  async remember(key, entries, source = 'automatic') {
    const state = await this.get(key);
    if (source === 'automatic' && !state.automatic) return [];
    const changed = [];
    for (const entry of entries.slice(0, source === 'automatic' ? 3 : 1)) {
      if (!entry || !safeMemory(entry.text) || !/^[a-zA-Z0-9_.-]{1,64}$/.test(entry.label || '')) continue;
      const existing = state.facts.find(f => f.label === entry.label);
      if (existing?.text === entry.text.trim()) continue;
      // Automatic extraction cannot overwrite a user's explicit memory/correction.
      if (existing && existing.source === 'manual' && source === 'automatic') continue;
      if (!existing && state.facts.length >= 100) continue;
      const fact = { id: existing?.id || randomBytes(4).toString('hex'), label: entry.label, text: entry.text.trim(), source, updatedAt: new Date().toISOString() };
      if (existing) state.facts[state.facts.indexOf(existing)] = fact;
      else state.facts.push(fact);
      changed.push(fact);
    }
    await this.put(key, state);
    return changed;
  }
}

export function memoryContext(state) {
  return {
    persona: state.persona,
    facts: state.facts.map(({ label, text }) => ({ label, text })),
    automatic: state.automatic,
  };
}
