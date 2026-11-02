import { resolve } from 'node:path';
import { loadIdentity } from './groups.js';
import { loadMediaConfig } from './media.js';

export function loadConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] || fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
    return value;
  };
  const secret = key => {
    const value = env[key] || '';
    if (value.length < 32 || /replace-with/i.test(value)) throw new Error(`Set a random ${key} (32+ characters)`);
    return value;
  };
  const ids = key => new Set((env[key] || '').split(',').map(x => x.trim()).filter(Boolean));
  const url = (key, fallback) => {
    const value = new URL(env[key] || fallback);
    if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.search || value.hash) throw new Error(`Invalid ${key}`);
    return value.href.replace(/\/$/, '');
  };
  const backend = env.MODEL_BACKEND || 'api';
  if (!['api', 'codex'].includes(backend)) throw new Error('Invalid MODEL_BACKEND');
  const adminToken = secret('ADMIN_TOKEN');
  const onebotSecret = secret('ONEBOT_SECRET');
  const onebotToken = secret('ONEBOT_TOKEN');
  if (new Set([adminToken, onebotSecret, onebotToken]).size !== 3) throw new Error('Use three different secrets');
  const allowedUsers = ids('ALLOWED_USERS'), allowedGroups = ids('ALLOWED_GROUPS');
  const identity = loadIdentity(env.COMPANION_IDENTITY_FILE, { allowedUsers, allowedGroups, backend });
  return {
    host: env.HOST || '127.0.0.1', port: number('PORT', 3789, 0, 65535),
    adminToken, onebotSecret, onebotToken,
    allowedUsers, allowedGroups, ...identity,
    onebotUrl: url('ONEBOT_URL', 'http://127.0.0.1:3000'),
    dataDir: resolve(env.DATA_DIR || './data'), workspace: resolve(env.WORKSPACE_DIR || './workspace'),
    tasksFile: resolve(env.TASKS_FILE || './config/tasks.json'), enableTasks: env.ENABLE_TASKS === 'true',
    backend, baseUrl: url('MODEL_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    apiKey: env.MODEL_API_KEY || '', model: env.MODEL_NAME || 'qwen-plus',
    timeout: number('MODEL_TIMEOUT_MS', 90000, 100, 300000),
    codexBin: env.CODEX_BIN || 'codex', codexHome: env.CODEX_HOME || '',
    codexModel: env.CODEX_MODEL || '',
    codexWork: env.ENABLE_CODEX_WORK === 'true',
    workTimeout: number('CODEX_WORK_TIMEOUT_MS', 300000, 1000, 900000),
    autoMemory: env.AUTO_MEMORY !== 'false',
    replyDelay: number('REPLY_DELAY_MS', 500, 0, 5000),
    groupDebounce: number('GROUP_DEBOUNCE_MS', 1200, 0, 5000),
    voice: loadMediaConfig(env.TTS_CONFIG_FILE, 'voice'),
    music: loadMediaConfig(env.MUSIC_CONFIG_FILE, 'music'),
    socialEnabled: env.ENABLE_QQ_SOCIAL === 'true',
  };
}
