import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export async function limitedBody(response, limit) {
  const chunks = []; let size = 0;
  if (!response.body) throw new Error('Empty response');
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Response exceeds limit');
      chunks.push(chunk);
    }
  } catch { throw new Error('Response could not be read within limits'); }
  return Buffer.concat(chunks);
}
export async function jsonRequest(url, body, token, { timeout = 45000, limit = 1048576, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error();
    return JSON.parse((await limitedBody(response, limit)).toString('utf8'));
  } catch { throw new Error('Remote service request failed'); } // Never expose provider bodies or credentials.
}
export function loadMediaConfig(file, kind) {
  if (!file) return { enabled: false };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const base = new URL(data.baseUrl || (kind === 'voice' ? 'https://dashscope.aliyuncs.com' : 'https://api.minimax.cn'));
  const allowed = kind === 'voice' ? base.hostname === 'dashscope.aliyuncs.com' || /^[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(base.hostname) : ['api.minimax.cn', 'api.minimaxi.com'].includes(base.hostname);
  if (base.protocol !== 'https:' || !allowed || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname) || (base.port && base.port !== '443')) throw new Error('Invalid media service endpoint');
  if (typeof data.apiKey !== 'string' || data.apiKey.length < 20 || /[\r\n]/.test(data.apiKey)) throw new Error('Invalid media credential');
  if (kind === 'voice') {
    if (!['cosyvoice-v3.5-flash', 'cosyvoice-v3.5-plus', 'cosyvoice-v3-flash', 'cosyvoice-v3-plus', 'qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-tts-flash', 'qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash'].includes(data.model) || typeof data.voiceId !== 'string' || !/^[a-zA-Z0-9_.-]{1,160}$/.test(data.voiceId)) throw new Error('Invalid voice/model');
    for (const [field, maximum] of [['maxCharacters', 2000], ['dailyCharacters', 100000]]) if (data[field] !== undefined && (!Number.isInteger(data[field]) || data[field] < 1 || data[field] > maximum)) throw new Error('Invalid voice allowance');
  }
  if (kind === 'music' && data.dailySongs !== undefined && (!Number.isInteger(data.dailySongs) || data.dailySongs < 1 || data.dailySongs > 10)) throw new Error('Invalid music allowance');
  return { ...data, baseUrl: base.origin, enabled: data.enabled !== false };
}

// Reserve before external calls. Failed requests remain counted; no automatic retries.
export class UsageBudget {
  constructor(dir) { this.file = join(dir, 'media-usage.json'); this.chain = Promise.resolve(); }
  reserve(kind, amount, ceiling) {
    const operation = this.chain.then(async () => {
      const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
      let state = { date, counts: {} };
      try { const old = JSON.parse(await readFile(this.file, 'utf8')); if (old.date === date) state = old; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!state.counts || !Number.isFinite(state.counts[kind] || 0) || amount < 1 || (state.counts[kind] || 0) + amount > ceiling) throw new Error('Daily media allowance exhausted');
      state.counts[kind] = (state.counts[kind] || 0) + amount;
      await writeFile(`${this.file}.tmp`, JSON.stringify(state), { mode: 0o600 }); await rename(`${this.file}.tmp`, this.file);
    });
    this.chain = operation.catch(() => {}); return operation;
  }
}

export function aliyunAudioUrl(value) {
  const url = new URL(value);
  if (!url.hostname.endsWith('.aliyuncs.com') || url.username || url.password || url.port || !['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid audio result URL');
  url.protocol = 'https:'; // OSS supports TLS; keep signed query out of all logs/model inputs.
  return url.href;
}
export function voiceInstruction(style = '') {
  const base = '普通话，轻声自然，细腻温柔，随语义起伏。';
  const clean = String(style).replace(/[\x00-\x1f]/g, '').slice(0, 20);
  return base + clean;
}
export class SpeechService {
  constructor(config, budget, { fetcher = fetch } = {}) { this.config = config; this.budget = budget; this.fetcher = fetcher; }
  async synthesize(text, style = '') {
    const cfg = this.config;
    if (!cfg.enabled) throw new Error('Voice not configured');
    if (typeof text !== 'string' || !text.trim() || Array.from(text).length > (cfg.maxCharacters || 600)) throw new Error('Text exceeds voice length limit');
    await this.budget.reserve('voiceCharacters', Array.from(text).length, cfg.dailyCharacters || 10000);
    const result = await jsonRequest(`${cfg.baseUrl}/api/v1/services/audio/tts/SpeechSynthesizer`, { model: cfg.model, input: { text, voice: cfg.voiceId, format: 'wav', sample_rate: 24000, volume: 50, rate: 0.95, instruction: voiceInstruction(style) } }, cfg.apiKey, { fetcher: this.fetcher });
    let audio;
    if (result.output?.audio?.data) {
      const value = result.output.audio.data;
      if (typeof value !== 'string' || value.length > 16000000) throw new Error('Invalid voice data');
      audio = Buffer.from(value, 'base64');
    } else {
      let response;
      try { response = await this.fetcher(aliyunAudioUrl(result.output?.audio?.url), { redirect: 'error', signal: AbortSignal.timeout(20000) }); }
      catch { throw new Error('Voice download failed'); }
      if (!response.ok) throw new Error('Voice download failed');
      audio = await limitedBody(response, 12000000);
    }
    if (audio.length < 44 || audio.length > 12000000 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV result');
    return audio;
  }
}

export class MusicService {
  constructor(config, budget, { fetcher = fetch } = {}) { this.config = config; this.budget = budget; this.fetcher = fetcher; }
  async generate(prompt, lyrics) {
    if (!this.config.enabled) throw new Error('Music not configured');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000 || typeof lyrics !== 'string' || !lyrics.trim() || lyrics.length > 1500) throw new Error('Invalid music request');
    await this.budget.reserve('songs', 1, this.config.dailySongs || 2);
    const data = await jsonRequest(`${this.config.baseUrl}/v1/music_generation`, { model: this.config.model || 'music-3.0', prompt, lyrics, output_format: 'hex', audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'mp3' } }, this.config.apiKey, { timeout: 300000, limit: 24000000, fetcher: this.fetcher });
    const hex = data.data?.audio;
    if (data.base_resp?.status_code !== 0 || typeof hex !== 'string' || hex.length < 20 || hex.length > 22000000 || hex.length % 2 || !/^[a-fA-F0-9]+$/.test(hex)) throw new Error('Music generation failed');
    return Buffer.from(hex, 'hex');
  }
}
