import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { companion, work } from './model.js';
import { loadTasks, runProcess } from './tasks.js';
import { MemoryStore, memoryContext, safeMemory } from './memory.js';
import { splitReply } from './delivery.js';
import { Results } from './results.js';
import { setTimeout as delay } from 'node:timers/promises';

function equal(a, b) {
  return typeof a === 'string' && timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
export function validSignature(body, signature, secret) {
  return equal(signature, `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`);
}
function httpError(status) { return Object.assign(new Error(`HTTP ${status}`), { status }); }
async function bodyOf(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw httpError(413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function parseEvent(event, config) {
  if (event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  if (!Number.isSafeInteger(Number(event.self_id)) || Number(event.self_id) <= 0) return null;
  const user = String(event.user_id || ''), group = String(event.group_id || '');
  if (!config.allowedUsers.has(user) || String(event.self_id) === user) return null;
  if (!Number.isSafeInteger(Number(event.user_id)) || Number(event.user_id) <= 0) return null;
  if (event.message_type === 'group' && (!config.allowedGroups.has(group) || !Number.isSafeInteger(Number(group)) || Number(group) <= 0)) return null;
  // Require array format: avoids treating CQ codes as commands or mentions.
  if (!Array.isArray(event.message) || event.message.some(s => !s || typeof s !== 'object')) return null;
  if (event.message_type === 'group' && !event.message.some(s => s.type === 'at' && String(s.data?.qq) === String(event.self_id))) return null;
  const text = event.message.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('').trim();
  if (!text || text.length > 8000 || event.message_id === undefined) return null;
  // Reject stale/future signed events to bound replay window.
  if (!Number.isFinite(event.time) || Math.abs(Date.now() / 1000 - event.time) > 300) return null;
  const key = `${event.message_type}:${group}:${user}`;
  return { key, user, group, text, type: event.message_type, id: `${event.self_id}:${key}:${event.message_id}` };
}

export async function createApp(config, { model = companion, worker = work, logger = console } = {}) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  const tasks = config.enableTasks ? await loadTasks(config.tasksFile) : {};
  const memories = new MemoryStore(config.dataDir, config.autoMemory);
  const results = new Results(config.dataDir, config.workspace);
  const sessions = new Map(), pending = new Map(), seen = new Map(), chains = new Map(), rates = new Map();
  let jobs = 0, persist = Promise.resolve(), auditing = Promise.resolve(), stopping = false;
  const logPath = join(config.dataDir, 'audit.jsonl');
  const sessionPath = key => join(config.dataDir, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function history(key) {
    if (!sessions.has(key)) {
      try {
        const data = JSON.parse(await readFile(sessionPath(key), 'utf8'));
        if (!Array.isArray(data) || data.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Corrupt history');
        sessions.set(key, data.slice(-12));
      } catch (error) { if (error.code !== 'ENOENT') throw error; sessions.set(key, []); }
    }
    return sessions.get(key);
  }
  function save(key, messages) {
    sessions.set(key, messages);
    if (sessions.size > 500) sessions.delete(sessions.keys().next().value);
    // Serialize atomic replacements; a failure must not poison subsequent writes.
    const operation = persist.then(async () => {
      const file = sessionPath(key);
      await writeFile(`${file}.tmp`, JSON.stringify(messages), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    persist = operation.catch(() => {});
    return operation;
  }
  function audit(item) {
    const operation = auditing.then(() => appendFile(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...item })}\n`, { mode: 0o600 }));
    auditing = operation.catch(() => {});
    return operation;
  }
  async function reply(event, text) {
    const chunks = splitReply(text);
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) await delay(config.replyDelay ?? 500);
      const response = await fetch(`${config.onebotUrl}/send_msg`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.onebotToken}` },
        body: JSON.stringify({ message_type: event.type, ...(event.type === 'group' ? { group_id: Number(event.group) } : { user_id: Number(event.user) }), message: [{ type: 'text', data: { text: chunks[index] } }] }),
      });
      if (!response.ok) throw new Error('OneBot HTTP failure');
      const data = await response.json();
      if (data.status !== 'ok' || data.retcode !== 0) throw new Error('OneBot rejected reply');
    }
  }
  function propose(key, item) {
    for (const [token, entry] of pending) if (entry.key === key) pending.delete(token);
    const token = randomBytes(12).toString('hex');
    pending.set(token, { ...item, key, expires: Date.now() + 60000 });
    return `准备执行：${item.summary}${item.kind === 'codex' ? `\n实际任务内容：${item.prompt}\n范围：新的独立任务目录；不修改服务器系统配置。` : ''}\n60秒内发送 /确认 ${token}，或 /取消。`;
  }
  const canWork = config.backend === 'codex' && config.codexWork;
  async function handle(event) {
    const { key, text } = event;
    const now = Date.now();
    for (const [token, item] of pending) if (item.expires <= now) pending.delete(token);
    if (text === '/帮助' || text === '/help') return '/状态 /重置 /记忆 /记住 内容 /纠正 编号 内容 /忘记 编号 /清空记忆 /设定 内容 /自动记忆 开或关\n/干活 任务描述 /结果 编号 /文件 编号 相对路径 /取消\n/任务 /运行 任务名 /确认 确认码\n普通文字直接聊天，群聊需要@机器人。记忆按会话隔离。';
    if (text === '/状态') return `Linux Remote Contact 在线\n模型后端：${config.backend}\n排队/运行：${jobs}\nCodex工作模式：${canWork ? '已启用' : '关闭'}\n预设任务：${config.enableTasks ? '已启用' : '关闭'}`;
    if (text === '/重置') { await save(key, []); return '近期对话已清空，长期记忆与角色设定保留。'; }
    if (text === '/记忆') {
      const state = await memories.get(key);
      return `本会话长期记忆（${state.facts.length}/100），自动记忆：${state.automatic ? '开' : '关'}\n角色设定：${state.persona || '默认'}\n${state.facts.map(f => `${f.id}：${f.text}`).join('\n') || '尚无长期记忆。'}`;
    }
    if (text === '/清空记忆') {
      const { automatic } = await memories.get(key);
      await memories.put(key, { facts: [], persona: '', automatic });
      await save(key, []);
      return '本会话的长期记忆、角色设定与近期对话已清空；任务产物不受影响。';
    }
    if (text.startsWith('/自动记忆 ')) {
      const value = text.slice(6).trim();
      if (!['开', '关'].includes(value)) return '用法：/自动记忆 开 或 /自动记忆 关';
      const state = await memories.get(key); state.automatic = value === '开'; await memories.put(key, state);
      return `自动记忆已${value === '开' ? '开启' : '关闭'}，已有记忆保留。`;
    }
    if (text.startsWith('/设定 ')) {
      const value = text.slice(4).trim();
      if (!value || value.length > 1000) return '设定长度须为1～1000字符。';
      const state = await memories.get(key); state.persona = value; await memories.put(key, state);
      return '角色名称与交流风格设定已保存；不会改变任务权限。';
    }
    if (text.startsWith('/记住 ')) {
      const value = text.slice(4).trim();
      if (!safeMemory(value)) return '请保存400字符以内的非敏感偏好或约定，不要记录凭证。';
      const state = await memories.get(key);
      if (state.facts.length >= 100) return '记忆已满，请先 /忘记 一条或 /纠正 已有记忆。';
      const [fact] = await memories.remember(key, [{ label: `manual.${randomBytes(8).toString('hex')}`, text: value }], 'manual');
      return `已记住（${fact.id}）：${fact.text}`;
    }
    if (text.startsWith('/纠正 ') || text.startsWith('/忘记 ')) {
      const [, id, content] = text.match(/^\/\S+\s+(\S+)(?:\s+([\s\S]+))?$/) || [];
      const state = await memories.get(key), index = state.facts.findIndex(f => f.id === id);
      if (index < 0) return '未找到该记忆编号，发送 /记忆 查看。';
      if (text.startsWith('/纠正 ')) {
        if (!safeMemory(content)) return '纠正内容须为400字符以内的非敏感信息。';
        state.facts[index] = { ...state.facts[index], text: content.trim(), source: 'manual', updatedAt: new Date().toISOString() };
      } else state.facts.splice(index, 1);
      await memories.put(key, state); await save(key, []);
      return '记忆已更新，近期对话也已清空，避免旧说法继续影响回答。';
    }
    if (text === '/取消') {
      for (const [token, item] of pending) if (item.key === key) pending.delete(token);
      return '待确认任务已取消；已开始的任务不受影响。';
    }
    if (text.startsWith('/干活 ')) {
      if (!canWork) return 'Codex工作模式未启用，请管理员设置 ENABLE_CODEX_WORK=true 并使用原生Linux部署。';
      const prompt = text.slice(4).trim();
      if (!prompt) return '请描述希望完成的任务。';
      return propose(key, { kind: 'codex', prompt, summary: prompt });
    }
    if (text.startsWith('/结果 ') || text.startsWith('/文件 ')) {
      const [, id, name] = text.match(/^\/\S+\s+(\S+)(?:\s+([\s\S]+))?$/) || [];
      try {
        const result = await results.get(key, id);
        if (text.startsWith('/文件 ')) return await results.textFile(result, name || '');
        return `任务 ${result.id}：${result.status}\n${result.output || '暂无完成结果'}\n产物（最多100个）：\n${(await results.files(result)).join('\n') || '无文件'}\n读取：/文件 ${result.id} 相对路径`;
      } catch { return '结果不可访问：请核对当前会话、任务编号、相对路径及文件类型（UTF-8文本，最大64KB）。'; }
    }
    if (text === '/任务') return Object.entries(tasks).map(([name, task]) => `${name}：${task.description || name}`).join('\n') || '任务未启用。';
    if (text.startsWith('/运行 ')) {
      const name = text.slice(4).trim();
      if (!Object.hasOwn(tasks, name)) return '未知任务。发送 /任务 查看可用任务。';
      return propose(key, { kind: 'preset', name, summary: `${name}：${tasks[name].description || name}` });
    }
    if (text.startsWith('/确认 ')) {
      const token = text.slice(4).trim(), item = pending.get(token);
      if (!item || item.key !== key || item.expires <= now) return '确认码无效、过期或不属于本会话。';
      pending.delete(token); // Consume BEFORE any execution, including failure.
      if (item.kind === 'codex') {
        if (!canWork) return 'Codex工作模式已关闭。';
        const result = await results.create(key, item.summary);
        await audit({ kind: 'codex-start', user: event.user, group: event.group, result: result.id });
        await reply(event, `任务已开始：${result.id}\n完成后会在此会话回复。`);
        try {
          result.output = await worker(config, item.prompt, result.cwd);
          result.status = 'completed';
        } catch {
          result.output = '执行失败或超时；目录可能有部分文件，不会自动重试。'; result.status = 'failed';
        }
        await results.put(result);
        await audit({ kind: 'codex-end', user: event.user, result: result.id, status: result.status });
        const answer = `任务 ${result.id}：${result.status}\n${result.output}\n查看产物：/结果 ${result.id}`;
        await save(key, [...await history(key), { role: 'user', content: `已确认任务：${item.summary}` }, { role: 'assistant', content: answer }].slice(-12));
        return answer;
      }
      const task = tasks[item.name];
      await audit({ kind: 'task-start', user: event.user, group: event.group, task: item.name });
      const result = await runProcess(task.command, task.args, { cwd: config.workspace, timeout: task.timeoutMs });
      await audit({ kind: 'task-end', user: event.user, task: item.name, code: result.code, timedOut: result.timedOut, truncated: result.truncated });
      return `任务 ${item.name}：退出码 ${result.code}${result.timedOut ? '，超时已终止' : ''}${result.truncated ? '，输出超限已终止' : ''}\n${result.output || '（无输出）'}`;
    }
    if (text.startsWith('/')) return '未知命令。发送 /帮助 查看。';
    const previous = await history(key);
    const input = [...previous, { role: 'user', content: text }].slice(-13);
    const state = await memories.get(key);
    const response = await model(config, input, { ...memoryContext(state), workEnabled: canWork });
    const output = typeof response === 'string' ? { reply: response, memories: [], task: null } : response;
    if (!output || typeof output.reply !== 'string' || !output.reply.trim()) throw new Error('Invalid reply');
    const changed = await memories.remember(key, Array.isArray(output.memories) ? output.memories : []);
    let answer = output.reply;
    if (output.task && canWork && typeof output.task.prompt === 'string' && output.task.prompt.trim() && output.task.prompt.length <= 8000 && typeof output.task.summary === 'string' && output.task.summary.trim() && output.task.summary.length <= 500) {
      answer += `\n\n${propose(key, { ...output.task, kind: 'codex' })}`;
    }
    if (changed.length) answer += `\n\n[记忆已更新：${changed.map(f => f.id).join('、')}，可用 /记忆 查看]`;
    await save(key, [...input, { role: 'assistant', content: output.reply }].slice(-12));
    return answer;
  }
  function enqueue(event) {
    const previous = chains.get(event.key) || Promise.resolve();
    jobs++;
    const job = previous.then(async () => {
      try { await reply(event, await handle(event)); }
      catch { logger.error('message_failed'); await reply(event, '处理失败，请管理员检查模型、OneBot与服务日志；本条不会自动重试。').catch(() => logger.error('reply_failed')); }
    }).finally(() => { jobs--; if (chains.get(event.key) === job) chains.delete(event.key); });
    chains.set(event.key, job);
  }
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: !stopping });
      if (req.method === 'GET' && path === '/') {
        const html = await readFile(new URL('../public/index.html', import.meta.url));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'", 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(html);
      }
      if (req.method === 'GET' && ['/ui.js', '/ui.css'].includes(path)) {
        const data = await readFile(new URL(`../public${path}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': path.endsWith('.js') ? 'text/javascript' : 'text/css', 'X-Content-Type-Options': 'nosniff' });
        return res.end(data);
      }
      if (req.method === 'GET' && path === '/api/status') {
        if (!equal(req.headers.authorization, `Bearer ${config.adminToken}`)) throw httpError(401);
        return send(res, 200, { ok: true, backend: config.backend, jobs, tasksEnabled: config.enableTasks, tasks: Object.keys(tasks), allowedUsers: config.allowedUsers.size, allowedGroups: config.allowedGroups.size, uptimeSeconds: Math.floor(process.uptime()) });
      }
      if (req.method !== 'POST' || path !== '/api/onebot/event') throw httpError(404);
      if (stopping || jobs >= 32) throw httpError(503);
      const raw = await bodyOf(req);
      if (!validSignature(raw, req.headers['x-signature'], config.onebotSecret)) throw httpError(401);
      let data;
      try { data = JSON.parse(raw); } catch { throw httpError(400); }
      if (!data || typeof data !== 'object') throw httpError(400);
      const event = parseEvent(data, config);
      if (!event) return send(res, 200, {});
      const now = Date.now();
      for (const [id, expires] of seen) if (expires < now) seen.delete(id);
      if (seen.has(event.id)) return send(res, 200, {});
      if (seen.size >= 10000) throw httpError(503);
      const rate = rates.get(event.user);
      if (rate && now - rate.start < 60000 && rate.count >= 15) throw httpError(429);
      rates.set(event.user, rate && now - rate.start < 60000 ? { start: rate.start, count: rate.count + 1 } : { start: now, count: 1 });
      seen.set(event.id, now + 600000);
      enqueue(event);
      // ACK immediately: slow model calls must not trigger OneBot delivery retries.
      send(res, 200, {});
    } catch (error) {
      send(res, error.status || 500, { error: error.status ? `HTTP ${error.status}` : 'Internal error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    async idle() { await Promise.all(chains.values()); await persist; await auditing; },
    async close() {
      stopping = true;
      await new Promise(resolve => server.close(resolve));
      await this.idle();
    },
  };
}
