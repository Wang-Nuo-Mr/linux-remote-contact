import { jsonRequest, limitedBody } from './media.js';
import { containsSensitive } from './memory.js';

export async function onebot(config, action, params, options = {}) {
  const data = await jsonRequest(`${config.onebotUrl}/${action}`, params, config.onebotToken, { timeout: 30000, limit: 2000000, ...options });
  if (data.status !== 'ok' || data.retcode !== 0) throw new Error('QQ interface rejected request');
  if (typeof data.data?.result === 'number' && data.data.result !== 0) throw new Error('QQ operation returned an error');
  return data.data;
}
const kinds = new Set(['qzone_feed', 'qzone_posts', 'qzone_detail', 'qzone_profile', 'qzone_post', 'nickname', 'signature', 'avatar', 'song']);
const reads = new Set(['qzone_feed', 'qzone_posts', 'qzone_detail', 'qzone_profile']);
const id = value => typeof value === 'string' && /^[1-9][0-9]{4,15}$/.test(value) && Number.isSafeInteger(Number(value));
export function validateAction(action) {
  if (!action || !kinds.has(action.type)) throw new Error('Unknown action');
  const result = { type: action.type, target: action.target || '', content: action.content || '', style: action.style || '', postId: action.postId || '' };
  if (Object.values(result).some(x => typeof x !== 'string')) throw new Error('Invalid action fields');
  if (result.target && !id(result.target)) throw new Error('Invalid QQ number');
  if (result.postId && !/^[a-zA-Z0-9_-]{1,128}$/.test(result.postId)) throw new Error('Invalid post ID');
  if (result.content.length > (result.type === 'song' ? 1500 : 1200) || result.style.length > 1000) throw new Error('Action too long');
  if (!reads.has(result.type) && !result.content.trim()) throw new Error('Content required');
  if (['qzone_post', 'nickname', 'signature'].includes(result.type) && containsSensitive(result.content)) throw new Error('Do not publish sensitive information');
  if (result.type === 'nickname' && result.content.length > 32) throw new Error('Nickname too long');
  if (result.type === 'signature' && result.content.length > 120) throw new Error('Signature too long');
  if (result.type === 'qzone_detail' && !result.postId) throw new Error('Post ID required');
  if (result.type === 'avatar') avatarUrl(result.content);
  return result;
}
export function isReadAction(action) { return reads.has(action.type); }
export function isSocialOwner(config, event) { return Boolean(config.creator && event.user === config.creator.qq && event.type === 'private'); }
export function avatarUrl(value) {
  const url = new URL(value);
  const allowed = ['qpic.cn', 'gtimg.cn', 'aliyuncs.com', 'githubusercontent.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port || url.href.length > 4096) throw new Error('Avatar must be a QQ CDN, GitHub image or Alibaba OSS HTTPS URL');
  return url.href;
}
function content(value, length = 600) { return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').slice(0, length) : ''; }
export function summarizeSocial(type, data) {
  if (type === 'qzone_profile') return { name: content(data?.name, 100), description: content(data?.description, 500) };
  const rows = type === 'qzone_feed' ? data?.feeds : type === 'qzone_posts' ? data?.msglist : [data];
  if (!Array.isArray(rows)) throw new Error('Unexpected QQ data format');
  return { items: rows.slice(0, 5).map(row => ({ qq: String(row.uin || row.user_id || ''), nickname: content(row.nickname, 80), postId: content(row.tid, 128), text: content(row.content || row.html), time: Number(row.time) || 0, imageCount: Array.isArray(row.images) ? row.images.length : 0 })), hasMore: Boolean(data?.has_more) };
}
export async function readSocial(config, input, options = {}) {
  const action = validateAction(input); let result;
  if (action.type === 'qzone_feed') result = await onebot(config, 'get_qzone_feeds', { page_num: 1, count: 5 }, options);
  else if (action.type === 'qzone_posts') result = await onebot(config, 'get_qzone_msg_list', { ...(action.target ? { target_uin: action.target } : {}), pos: 0, num: 5 }, options);
  else if (action.type === 'qzone_detail') result = await onebot(config, 'get_qzone_msg_detail', { tid: action.postId, ...(action.target ? { target_uin: action.target } : {}), pos: 0, num: 5 }, options);
  else if (action.type === 'qzone_profile') result = await onebot(config, 'get_qzone_profile', action.target ? { target_uin: action.target } : {}, options);
  else throw new Error('Not a read action');
  return summarizeSocial(action.type, result);
}
export function actionSummary(input) {
  const action = validateAction(input);
  if (action.type === 'qzone_post') return `发表QQ空间说说（仅好友可见）：\n${action.content}`;
  if (action.type === 'nickname') return `修改QQ昵称为：${action.content}`;
  if (action.type === 'signature') return `修改QQ签名为：${action.content}`;
  if (action.type === 'avatar') return `更换QQ头像，图片地址：\n${action.content}`;
  if (action.type === 'song') return `生成歌曲（独立音乐服务，歌声不保证与日常音色一致）：\n风格：${action.style || '温柔清新的短歌'}\n歌词：\n${action.content}`;
  throw new Error('Not a write action');
}
export async function writeSocial(config, input, options = {}) {
  const action = validateAction(input);
  if (action.type === 'qzone_post') {
    const result = await onebot(config, 'send_qzone_msg', { content: action.content, images: [], ugc_right: 4 }, options);
    if (!result?.tid) throw new Error('Publication has no result ID; do not retry automatically');
    return { text: `空间接口已接受发表，Tid：${String(result.tid).slice(0, 128)}。\n回读：/空间详情 ${String(result.tid).slice(0, 128)}`, postId: String(result.tid) };
  }
  if (action.type === 'nickname') await onebot(config, 'set_qq_profile', { nickname: action.content }, options);
  else if (action.type === 'signature') await onebot(config, 'set_self_longnick', { longNick: action.content }, options);
  else if (action.type === 'avatar') {
    const response = await (options.fetcher || fetch)(avatarUrl(action.content), { redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Avatar download failed');
    const image = await limitedBody(response, 5000000);
    const png = image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = image[0] === 255 && image[1] === 216 && image[2] === 255;
    if (!png && !jpeg) throw new Error('Avatar must be PNG/JPEG');
    await onebot(config, 'set_qq_avatar', { file: `base64://${image.toString('base64')}` }, options);
  } else throw new Error('Unknown write action');
  return { text: 'QQ接口已接受修改；可在QQ资料页查看最终效果。' };
}
