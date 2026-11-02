import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { companion, work } from './model.js';
import { loadTasks, runProcess } from './tasks.js';
import { MemoryStore, memoryContext, safeMemory } from './memory.js';
import { splitReply } from './delivery.js';
import { Results } from './results.js';
import { GroupDirectory, displayName } from './groups.js';
import { SpeechService, MusicService, UsageBudget } from './media.js';
import { onebot, isSocialOwner, validateAction, isReadAction, actionSummary, readSocial, writeSocial } from './social.js';
import { setTimeout as delay } from 'node:timers/promises';
import { imageReferences, prepareImages } from './images.js';

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
  const memberNotice = event.post_type === 'notice' && event.notice_type === 'group_increase';
  if (!memberNotice && (event.post_type !== 'message' || !['private', 'group'].includes(event.message_type))) return null;
  const type = memberNotice ? 'group' : event.message_type;
  if (!Number.isSafeInteger(Number(event.self_id)) || Number(event.self_id) <= 0) return null;
  const user = String(event.user_id || ''), group = String(event.group_id || '');
  if (String(event.self_id) === user) return null;
  if (!Number.isSafeInteger(Number(event.user_id)) || Number(event.user_id) <= 0) return null;
  if (type === 'group' && (!config.allowedGroups.has(group) || !Number.isSafeInteger(Number(group)) || Number(group) <= 0)) return null;
  const policy = type === 'group' ? config.listeningGroups?.get(group) : null;
  if (!policy && (memberNotice || !config.allowedUsers.has(user))) return null;
  if (!Number.isFinite(event.time) || Math.abs(Date.now() / 1000 - event.time) > 300) return null;
  const key = `${type}:${group}:${user}`;
  const speaker = policy ? policy.members.get(user) || { qq: user, name: displayName(event.sender?.card || event.sender?.nickname, user) } : null;
  if (memberNotice) return { key, user, group, text: '', type, listening: true, memberNotice: true, speaker, conversationKey: `group:${group}:shared`, id: `${event.self_id}:join:${group}:${user}:${event.time}`, time: event.time };
  // Require array format: avoids treating CQ codes as commands or mentions.
  if (!Array.isArray(event.message) || event.message.some(s => !s || typeof s !== 'object')) return null;
  const mentioned = event.message.some(s => s.type === 'at' && String(s.data?.qq) === String(event.self_id));
  if (type === 'group' && !policy && !mentioned) return null;
  const segmentTypes = [...new Set(event.message.filter(s => s.type !== 'text').map(s => String(s.type).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)).filter(Boolean))].slice(0, 10);
  let text = event.message.filter(s => s.type === 'text').map(s => String(s.data?.text || '')).join('').trim();
  const imageRefs = imageReferences(event.message);
  if (!text && imageRefs.length) text = '[收到图片]';
  if (!text && policy && segmentTypes.length) text = `[非文本消息：${segmentTypes.join('、')}；未解析内容]`;
  if (!text || text.length > 8000 || event.message_id === undefined) return null;
  // Reject stale/future signed events to bound replay window.
  if (!Number.isFinite(event.time) || Math.abs(Date.now() / 1000 - event.time) > 300) return null;
  // Shared conversation/queue; permissions, profiles and confirmations stay per sender.
  return { key, user, group, text, type, imageRefs, id: `${event.self_id}:${key}:${event.message_id}`, listening: Boolean(policy), mentioned, segmentTypes,
    conversationKey: policy ? `group:${group}:shared` : key,
    speaker, time: event.time };
}

export async function createApp(config, { model = companion, worker = work, logger = console, speech, music, socialRead = readSocial, socialWrite = writeSocial, imageLoader = prepareImages } = {}) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await mkdir(config.workspace, { recursive: true, mode: 0o700 });
  const tasks = config.enableTasks ? await loadTasks(config.tasksFile) : {};
  const memories = new MemoryStore(config.dataDir, config.autoMemory);
  const directory = new GroupDirectory(config.dataDir, config.listeningGroups);
  const budget = new UsageBudget(config.dataDir);
  speech ||= new SpeechService(config.voice || { enabled: false }, budget);
  music ||= new MusicService(config.music || { enabled: false }, budget);
  const lastVoice = new Map();
  const results = new Results(config.dataDir, config.workspace);
  const sessions = new Map(), pending = new Map(), seen = new Map(), chains = new Map(), rates = new Map(), messageBatches = new Map();
  let jobs = 0, persist = Promise.resolve(), auditing = Promise.resolve(), stopping = false;
  const logPath = join(config.dataDir, 'audit.jsonl');
  const sessionPath = key => join(config.dataDir, `${createHash('sha256').update(key).digest('hex')}.json`);
  async function history(key, limit = 12) {
    if (!sessions.has(key)) {
      try {
        const data = JSON.parse(await readFile(sessionPath(key), 'utf8'));
        if (!Array.isArray(data) || data.some(m => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) throw new Error('Corrupt history');
        sessions.set(key, data.slice(-limit));
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
    const envelope = typeof text === 'string' ? { text } : text;
    const chunks = splitReply(envelope.text);
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
    if (envelope.speech && config.voice?.enabled) {
      const recent = lastVoice.get(event.conversationKey) || 0;
      if (!envelope.speech.explicit && Date.now() - recent < 30000) return;
      try {
        const audio = await speech.synthesize(envelope.speech.text, envelope.speech.style);
        await onebot(config, 'send_msg', { message_type: event.type, ...(event.type === 'group' ? { group_id: Number(event.group) } : { user_id: Number(event.user) }), message: [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }] });
        lastVoice.set(event.conversationKey, Date.now());
        await audit({ kind: 'voice-sent', group: event.group, user: event.user, characters: Array.from(envelope.speech.text).length });
      } catch {
        logger.error('voice_failed');
        await reply(event, '文字已发送，语音合成或QQ语音发送未成功，请检查音色、接口权限和今日语音额度；不会自动重试。');
      }
    }
  }
  function propose(key, item) {
    for (const [token, entry] of pending) if (entry.key === key) pending.delete(token);
    const token = randomBytes(12).toString('hex');
    pending.set(token, { ...item, key, expires: Date.now() + (item.kind === 'social' ? 300000 : 60000) });
    return `准备执行：${item.summary}${item.kind === 'codex' ? `\n实际任务内容：${item.prompt}\n范围：新的独立任务目录；不修改服务器系统配置。` : ''}\n${item.kind === 'social' ? '5分钟' : '60秒'}内发送 /确认 ${token}，或 /取消。`;
  }
  const canWork = config.backend === 'codex' && config.codexWork;
  function capabilities(event, voiceMode = 'auto') {
    return { deployment: 'Ubuntu Linux QQ助手；Codex生成正文，程序负责验签、记忆和接口执行。操作记录与本次桌面配置聊天不会自动变成对话经历。', voice: { available: Boolean(config.voice?.enabled), mode: voiceMode, maxCharacters: config.voice?.maxCharacters || 600 }, music: Boolean(config.music?.enabled) && isSocialOwner(config, event), social: Boolean(config.socialEnabled) && isSocialOwner(config, event), socialPrivateOnly: true, imageInput: config.backend === 'codex', textOnlyInputs: config.backend !== 'codex', crossChatSend: false, artifactDelivery: 'text-only' };
  }
  function formatRead(data) {
    if (data.items) return data.items.map((item, i) => `${i + 1}. ${item.nickname || item.qq || '动态'}${item.qq ? `（${item.qq}）` : ''}\n${item.text || '无可读取文字'}${item.imageCount ? `\n[含${item.imageCount}张图片，尚未识图]` : ''}${item.postId ? `\nTid：${item.postId}` : ''}`).join('\n\n') || '接口返回列表为空。';
    return `空间名称：${data.name || '未设置'}\n空间说明：${data.description || '未设置'}`;
  }
  function proposeSocial(event, input) {
    if (!isSocialOwner(config, event)) return 'QQ空间和资料操作请由创造者在私聊中发起。';
    const action = validateAction(input);
    if (action.type === 'song' ? !config.music?.enabled : !config.socialEnabled) return action.type === 'song' ? '音乐服务尚未配置。百炼语音密钥用于说话；唱歌需要单独的音乐服务凭据。' : 'QQ空间和资料接口尚未启用。';
    return propose(event.key, { kind: 'social', action, summary: actionSummary(action) });
  }
  async function handle(event) {
    const { key, text } = event;
    const batch = event.batch || [event];
    if (event.listening) for (const message of batch) message.speaker = await directory.observe(message);
    if (event.memberNotice) return null;
    const chatKey = event.conversationKey, limit = event.listening ? 60 : 12;
    const controller = !event.listening || event.user === config.creator?.qq;
    const settingsKey = event.listening ? `group:${event.group}:assistant` : key;
    if (!controller && /^\/(?:干活|运行|确认|设定|重置|语音模式)(?:\s|$)/.test(text)) return `这项管理或执行操作仅由创造者${config.creator.name}的账号授权。`;
    const now = Date.now();
    for (const [token, item] of pending) if (item.expires <= now) pending.delete(token);
    if (text === '/能力' || text === '/自身说明') return `我由${config.creator?.name || '管理员'}部署在Ubuntu服务器上，使用${config.backend}生成回复。\n语音：${config.voice?.enabled ? '已配置，文字和语音对应，可按语境调整语气' : '未配置'}\n音乐生成：${config.music?.enabled ? '已配置独立音乐服务' : '未配置，不能用语音API直接冒充唱歌'}\nQQ空间与资料：${config.socialEnabled ? '已启用；创造者私聊可读取，写入需确认' : '未启用'}\n${config.listeningGroups.size ? '指定群无需@，由我判断是否回答；' : ''}每个人的记忆独立，固定创造者身份保留。\n图片：${config.backend === 'codex' ? '支持当前消息的PNG、JPEG、WebP原图理解' : '当前后端未接入'}；语音输入尚未转写。\n我不自动知道桌面端完整部署过程。`;
    if (text === '/声线') return config.voice?.enabled ? `已配置固定音色，模型：${config.voice.model}。\n/语音 内容：直接朗读\n/语音模式 自动、按需、关闭：切换当前会话的语音方式。` : '百炼声线尚未配置完成。';
    if (text.startsWith('/语音模式 ')) {
      const mode = text.slice(6).trim();
      if (!['自动', '按需', '关闭'].includes(mode)) return '用法：/语音模式 自动 或 按需 或 关闭';
      const settings = await memories.get(settingsKey); settings.voiceMode = mode; await memories.put(settingsKey, settings);
      return `本会话语音模式：${mode}。文字回复继续保留。`;
    }
    if (text.startsWith('/语音 ')) {
      if (!config.voice?.enabled) return '百炼声线尚未配置完成。';
      const value = text.slice(4).trim();
      if (!value || Array.from(value).length > (config.voice.maxCharacters || 600)) return `语音文本须为1～${config.voice.maxCharacters || 600}字。`;
      return { text: value, speech: { text: value, style: '温柔自然地轻声说话', explicit: true } };
    }
    const readCommand = text.match(/^\/(空间动态|空间说说|空间资料|空间详情)(?:\s+([^\s]+))?(?:\s+([^\s]+))?$/);
    if (readCommand) {
      if (!config.socialEnabled || !isSocialOwner(config, event)) return '空间读取请由创造者在私聊中使用，且需启用QQ空间接口。';
      const [, command, first = '', second = ''] = readCommand;
      const action = validateAction({ type: { 空间动态: 'qzone_feed', 空间说说: 'qzone_posts', 空间资料: 'qzone_profile', 空间详情: 'qzone_detail' }[command], target: command === '空间详情' ? second : first, postId: command === '空间详情' ? first : '' });
      try { const data = await socialRead(config, action); await audit({ kind: 'social-read', user: event.user, action: action.type }); return formatRead(data); }
      catch { logger.error('social_read_failed'); return 'QQ空间接口读取失败或账号尚未开通空间；没有取得可用内容。'; }
    }
    const writeCommand = text.match(/^\/(发动态|昵称|签名|头像)\s+([\s\S]+)$/);
    if (writeCommand) return proposeSocial(event, { type: { 发动态: 'qzone_post', 昵称: 'nickname', 签名: 'signature', 头像: 'avatar' }[writeCommand[1]], content: writeCommand[2].trim() });
    if (text.startsWith('/唱歌 ')) {
      const [style, ...lyrics] = text.slice(4).split('|');
      return proposeSocial(event, { type: 'song', style: lyrics.length ? style.trim() : '温柔清新的短歌', content: lyrics.length ? lyrics.join('|').trim() : style.trim() });
    }
    if (text === '/帮助' || text === '/help') return `/状态 /能力 /重置 /记忆 /认识 /新成员 /记住 内容 /纠正 编号 内容 /忘记 编号 /清空记忆 /设定 内容 /自动记忆 开或关\n/声线 /语音 内容 /语音模式 自动或按需或关闭\n创造者私聊：/空间动态 /空间说说 [QQ号] /空间资料 [QQ号] /空间详情 Tid [QQ号]\n/发动态 完整正文 /昵称 内容 /签名 内容 /头像 HTTPS图片地址 /唱歌 曲风|原创歌词\n/干活 任务描述 /结果 编号 /文件 编号 相对路径 /取消\n/任务 /运行 任务名 /确认 确认码\n${event.listening ? '本群无需@，由Codex判断是否开口。个人记忆按QQ号区分，任务与群管理仅创造者可操作。' : '普通文字直接聊天，普通群聊需要@机器人。记忆按会话隔离。'}`;
    if (text === '/状态') return `Linux Remote Contact 在线\n模型后端：${config.backend}\n排队/运行：${jobs}\n群聊模式：${event.listening ? '全消息理解，自主决定回复' : '私聊或@触发'}\nCodex工作模式：${canWork && controller ? '已启用' : '关闭或无执行权限'}\n预设任务：${config.enableTasks ? '已启用' : '关闭'}`;
    if (text === '/重置') { await save(chatKey, []); return '近期对话已清空，长期记忆、角色设定与固定创造者身份保留。'; }
    if (text === '/新成员' && event.listening) {
      const people = (await directory.members(event.group)).filter(m => m.status === 'new');
      return `新成员／待了解：\n${people.map(m => `${m.name}（QQ ${m.qq}）`).join('\n') || '暂无新成员。'}`;
    }
    if (text === '/认识' && event.listening) {
      const people = [];
      for (const member of await directory.members(event.group)) {
        const state = await memories.get(`group:${event.group}:${member.qq}`);
        people.push(`${member.name}（QQ ${member.qq}${member.qq === config.creator.qq ? '，创造者' : member.status === 'new' ? '，新成员／待了解' : ''}）：\n${state.facts.map(f => `${f.id}：${f.text}`).join('\n') || '还在逐渐了解。'}`);
      }
      return people.join('\n\n');
    }
    if (text === '/记忆') {
      const state = await memories.get(key);
      return `${event.listening ? `${event.speaker.name}的个人` : '本会话'}长期记忆（${state.facts.length}/100），自动记忆：${state.automatic ? '开' : '关'}\n角色设定：${(await memories.get(settingsKey)).persona || '默认'}\n${state.facts.map(f => `${f.id}：${f.text}`).join('\n') || '尚无长期记忆。'}${config.creator ? `\n固定身份：${config.creator.name}（QQ ${config.creator.qq}）是创造者，普通记忆命令不会修改。` : ''}`;
    }
    if (text === '/清空记忆') {
      const { automatic } = await memories.get(key);
      await memories.put(key, { facts: [], persona: '', automatic });
      if (!event.listening) await save(chatKey, []);
      return event.listening ? '你在本群的个人记忆已清空；其他成员、群上下文和固定创造者身份保留。' : '本会话的长期记忆、角色设定与近期对话已清空；任务产物及固定创造者身份不受影响。';
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
      const state = await memories.get(settingsKey); state.persona = value; await memories.put(settingsKey, state);
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
      await memories.put(key, state);
      if (!event.listening) await save(chatKey, []);
      return event.listening ? '你的个人记忆已更新，下一次判断将以新的个人档案为准；群上下文保留。' : '记忆已更新，近期对话也已清空，避免旧说法继续影响回答。';
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
      if (item.kind === 'social') {
        if (!isSocialOwner(config, event)) return '仅创造者私聊可以确认QQ空间、资料或歌曲操作。';
        try {
          await audit({ kind: 'social-write-start', user: event.user, action: item.action.type });
          if (item.action.type === 'song') {
            if (!config.music?.enabled) return '音乐服务已关闭。';
            await reply(event, '开始生成歌曲，完成后发送音频；生成的歌声不保证与日常声线一致。');
            const audio = await music.generate(item.action.style || '温柔清新的短歌', item.action.content);
            await onebot(config, 'send_private_msg', { user_id: Number(event.user), message: [{ type: 'record', data: { file: `base64://${audio.toString('base64')}` } }] });
            await audit({ kind: 'song-sent', user: event.user }); return '歌曲音频已交给QQ发送。';
          }
          if (!config.socialEnabled) return 'QQ空间与资料功能已关闭。';
          if (item.action.type === 'qzone_post') await budget.reserve('qzonePosts', 1, 3);
          const result = await socialWrite(config, item.action);
          await audit({ kind: 'social-write-end', user: event.user, action: item.action.type, status: 'accepted' });
          return result.text;
        } catch { logger.error('social_write_failed'); await audit({ kind: 'social-write-end', user: event.user, action: item.action.type, status: 'failed-or-unknown' }); return '本次接口操作未确认成功，可能涉及账号权限、服务额度或网络问题；不会自动重试，以免重复发表或修改。'; }
      }
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
        await save(chatKey, [...await history(chatKey, limit), { role: 'user', content: event.listening ? JSON.stringify({ speaker: event.speaker, text: `已确认任务：${item.summary}` }) : `已确认任务：${item.summary}` }, { role: 'assistant', content: answer }].slice(-limit));
        return answer;
      }
      const task = tasks[item.name];
      await audit({ kind: 'task-start', user: event.user, group: event.group, task: item.name });
      const result = await runProcess(task.command, task.args, { cwd: config.workspace, timeout: task.timeoutMs });
      await audit({ kind: 'task-end', user: event.user, task: item.name, code: result.code, timedOut: result.timedOut, truncated: result.truncated });
      return `任务 ${item.name}：退出码 ${result.code}${result.timedOut ? '，超时已终止' : ''}${result.truncated ? '，输出超限已终止' : ''}\n${result.output || '（无输出）'}`;
    }
    if (text.startsWith('/') && !event.listening) return '未知命令。发送 /帮助 查看。';
    const imageInput = await imageLoader(config, batch);
    try {
      const previous = await history(chatKey, limit);
      const incoming = batch.map(message => ({ role: 'user', content: event.listening ? JSON.stringify({ speaker: message.speaker, text: message.text, time: message.time, mentionedAssistant: message.mentioned, segmentTypes: message.segmentTypes }) : message.text }));
      const input = [...previous, ...incoming].slice(-limit - 1);
      const state = await memories.get(key);
      const settings = await memories.get(settingsKey);
      const voiceMode = { 自动: 'auto', 按需: 'requested', 关闭: 'off' }[settings.voiceMode] || 'auto';
      const context = { ...memoryContext(state), workEnabled: canWork && controller, creator: config.creator, assistant: config.assistant, capabilities: capabilities(event, voiceMode) };
      context.turn = { newMessages: batch.map(message => ({ senderQQ: message.user, text: message.text, time: message.time })) };
      context.imageAttachments = imageInput.attachments;
      if (imageInput.attachments.length) await audit({ kind: 'image-input', user: event.user, group: event.group, received: imageInput.attachments.length, attached: imageInput.paths.length });
      if (event.listening) {
        context.persona = (await memories.get(settingsKey)).persona;
        context.group = { id: event.group, mode: 'listen', speaker: event.speaker, newMessages: batch.map(message => ({ speaker: message.speaker, text: message.text })), participants: [] };
        for (const member of await directory.members(event.group)) {
          const profile = await memories.get(`group:${event.group}:${member.qq}`);
          context.group.participants.push({ ...member, creator: member.qq === config.creator.qq, facts: memoryContext(profile).facts, automatic: profile.automatic });
        }
      }
      // Retain every accepted group message, even when the model stays silent/fails.
      if (event.listening) await save(chatKey, input.slice(-limit));
      if (imageInput.attachments.length && !imageInput.paths.length && batch.every(message => message.text === '[收到图片]')) return config.backend === 'codex' ? '这次图片未能读取。请重发静态PNG、JPEG或WebP图片（每张不超过8MB，一条最多3张），也可以附上想问的问题。' : '当前API后端未接入图片理解，请管理员启用Codex图片后端。';
      const response = await model(config, input, context, { images: imageInput.paths });
      let output = typeof response === 'string' ? { reply: response, memories: [], task: null } : response;
      if (!output || typeof output.reply !== 'string' || (event.listening && typeof output.shouldReply !== 'boolean') || (!(event.listening && output.shouldReply === false) && !output.reply.trim())) throw new Error('Invalid reply');
      if (output.action && isReadAction(validateAction(output.action)) && context.capabilities.social) {
        try {
          const action = validateAction(output.action), data = await socialRead(config, action);
          await audit({ kind: 'social-read', user: event.user, action: action.type });
          const followup = await model(config, input, { ...context, automatic: false, workEnabled: false, capabilities: { ...context.capabilities, social: false, music: false }, toolResult: { type: action.type, data } }, { images: imageInput.paths });
          output = { ...followup, action: null, task: null, memories: [] };
          if (typeof output.reply !== 'string' || !output.reply.trim()) throw new Error('Empty read summary');
        } catch { logger.error('social_read_failed'); output = { shouldReply: true, reply: 'QQ空间读取未成功，没有取得可用内容。', memories: [], task: null, action: null }; }
      }
      const entries = Array.isArray(output.memories) ? output.memories.slice(0, 3) : [];
      const changed = [];
      if (event.listening) {
        const speakers = new Set(batch.map(message => message.user));
        const bySpeaker = new Map();
        for (const entry of entries) {
          const subject = entry?.subject ?? event.user;
          if (!speakers.has(subject)) continue;
          if (!bySpeaker.has(subject)) bySpeaker.set(subject, []);
          bySpeaker.get(subject).push(entry);
        }
        for (const [subject, facts] of bySpeaker) changed.push(...await memories.remember(`group:${event.group}:${subject}`, facts));
      } else changed.push(...await memories.remember(key, entries));
      if (event.listening && output.shouldReply === false) {
        await audit({ kind: 'group-decision', group: event.group, user: event.user, users: [...new Set(batch.map(message => message.user))], messages: batch.length, replied: false, memories: changed.length });
        return null;
      }
      let answer = output.reply;
      if (output.action && !isReadAction(output.action)) answer += `\n\n${proposeSocial(event, output.action)}`;
      if (output.task && canWork && controller && typeof output.task.prompt === 'string' && output.task.prompt.trim() && output.task.prompt.length <= 8000 && typeof output.task.summary === 'string' && output.task.summary.trim() && output.task.summary.length <= 500) {
        answer += `\n\n${propose(key, { ...output.task, kind: 'codex' })}`;
      }
      if (changed.length && !event.listening) answer += `\n\n[记忆已更新：${changed.map(f => f.id).join('、')}，可用 /记忆 查看]`;
      await save(chatKey, [...input, { role: 'assistant', content: output.reply }].slice(-limit));
      if (event.listening) await audit({ kind: 'group-decision', group: event.group, user: event.user, users: [...new Set(batch.map(message => message.user))], messages: batch.length, replied: true, memories: changed.length });
      if (config.voice?.enabled && voiceMode !== 'off' && output.voice?.enabled && Array.from(output.reply).length <= (config.voice.maxCharacters || 600) && !output.action && !output.task) return { text: answer, speech: { text: output.reply, style: output.voice.style || '', explicit: false } };
      return answer;
    } finally { await imageInput.cleanup(); }
  }
  function enqueue(event) {
    const queueKey = event.conversationKey;
    const batchable = !event.memberNotice && !event.text.startsWith('/');
    const quiet = event.type === 'private' ? config.privateDebounce ?? 3000 : config.groupDebounce ?? 4000;
    const maxWait = config.maxBatchWait ?? 12000;
    const open = messageBatches.get(queueKey);
    if (batchable && open) {
      open.messages.push(event); open.lastAt = Date.now(); jobs++; open.wake?.(); return;
    }
    // Commands/notices end the waiting window immediately, retaining queue order.
    if (open) { open.sealed = true; open.wake?.(); messageBatches.delete(queueKey); }
    const entry = { messages: [event], firstAt: Date.now(), lastAt: Date.now(), sealed: !batchable };
    const batch = entry.messages;
    if (batchable) messageBatches.set(queueKey, entry);
    const previous = chains.get(queueKey) || Promise.resolve();
    jobs++;
    const job = previous.then(async () => {
      if (batchable) {
        while (!entry.sealed) {
          const remaining = Math.min(entry.lastAt + quiet, entry.firstAt + maxWait) - Date.now();
          if (remaining <= 0) break;
          await new Promise(resolve => {
            const done = () => { clearTimeout(timer); entry.wake = null; resolve(); };
            const timer = setTimeout(done, remaining);
            entry.wake = done;
          });
        }
        entry.sealed = true;
        if (messageBatches.get(queueKey) === entry) messageBatches.delete(queueKey);
      }
      const current = batch.at(-1);
      if (batchable) current.batch = batch;
      try {
        if (batchable) await audit({ kind: 'chat-batch', type: current.type, group: current.group, user: current.user, messages: batch.length, waitedMs: Date.now() - entry.firstAt });
        const answer = await handle(current); if (answer !== null) await reply(current, answer);
      }
      catch { logger.error('message_failed'); if (!current.listening || batch.some(message => message.mentioned || message.imageRefs?.length) || current.text.startsWith('/')) await reply(current, '处理失败，请管理员检查模型、OneBot与服务日志；本条不会自动重试。').catch(() => logger.error('reply_failed')); }
    }).finally(() => { jobs -= batch.length; if (chains.get(queueKey) === job) chains.delete(queueKey); });
    chains.set(queueKey, job);
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
        return send(res, 200, { ok: true, backend: config.backend, jobs, tasksEnabled: config.enableTasks, tasks: Object.keys(tasks), allowedUsers: config.allowedUsers.size, allowedGroups: config.allowedGroups.size, listeningGroups: config.listeningGroups.size, voiceEnabled: Boolean(config.voice?.enabled), musicEnabled: Boolean(config.music?.enabled), socialEnabled: Boolean(config.socialEnabled), imageEnabled: config.backend === 'codex', receiveDelay: { privateMs: config.privateDebounce ?? 3000, groupMs: config.groupDebounce ?? 4000, maxWaitMs: config.maxBatchWait ?? 12000 }, uptimeSeconds: Math.floor(process.uptime()) });
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
      if (rate && now - rate.start < 60000 && rate.count >= (event.listening ? 60 : 15)) throw httpError(429);
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
      for (const entry of messageBatches.values()) { entry.sealed = true; entry.wake?.(); }
      await new Promise(resolve => server.close(resolve));
      await this.idle();
    },
  };
}
