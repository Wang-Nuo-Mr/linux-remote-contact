import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onebot } from './social.js';
import { runProcess } from './tasks.js';

// QQ download tokens belong to the transport only: never persist or prompt them.
export function imageReferences(segments) {
  return segments.filter(s => s.type === 'image').slice(0, 12).map(s => ({
    url: typeof s.data?.url === 'string' ? s.data.url.slice(0, 8192) : '',
    file: typeof s.data?.file === 'string' ? s.data.file.slice(0, 256) : '',
  }));
}
export function qqImageUrl(value) {
  const url = new URL(value);
  const allowed = ['qpic.cn', 'gtimg.cn', 'qq.com.cn', 'qq.com'].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  if (!allowed || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length > 8192) throw new Error('Unsupported QQ image URL');
  url.protocol = 'https:';
  return url.href;
}
function extension(data) {
  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (data.length >= 12 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpg';
  if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (data.length >= 13 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) {
    const width = data.readUInt16LE(6), height = data.readUInt16LE(8);
    if (!width || !height || width * height > 16000000) throw new Error('GIF dimensions too large');
    return 'gif';
  }
  throw new Error('Unsupported image format');
}
export async function gifFirstFrame(source, destination) {
  const result = await runProcess('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-max_alloc', '67108864', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-i', source, '-frames:v', '1', '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', '-threads', '1', destination], { timeout: 10000, limit: 2000 });
  if (result.code !== 0 || result.timedOut || result.truncated || (await stat(destination)).size > 8 * 1024 * 1024) throw new Error('GIF conversion failed');
  if (extension(await readFile(destination)) !== 'png') throw new Error('Invalid GIF conversion');
}
async function download(url, fetcher, limit) {
  const response = await fetcher(qqImageUrl(url), { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok || !response.body) throw new Error('QQ image download failed');
  if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw new Error('Image too large'); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Image too large');
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks);
  return { data, ext: extension(data) };
}
export async function prepareImages(config, messages, { fetcher = fetch, resolve = onebot, convertGif = gifFirstFrame } = {}) {
  const paths = [], attachments = [];
  let dir, bytes = 0, attempts = 0;
  const cleanup = async () => { if (dir) await rm(dir, { recursive: true, force: true }); };
  try {
    for (const [messageIndex, message] of messages.entries()) {
      for (const [imageIndex, ref] of (message.imageRefs || []).entries()) {
        const item = { message: messageIndex + 1, image: imageIndex + 1, senderQQ: message.user, status: 'unavailable' };
        attachments.push(item);
        if (config.backend !== 'codex') { item.reason = 'backend_unsupported'; continue; }
        if (attempts >= 4 || imageIndex >= 3 || bytes >= 16 * 1024 * 1024) { item.reason = 'batch_limit'; continue; }
        attempts++;
        try {
          let url;
          try { url = qqImageUrl(ref.url); }
          catch {
            // Only opaque QQ basenames may be resolved; never local paths or URLs.
            if (!/^[a-zA-Z0-9{][a-zA-Z0-9{}_.-]{0,199}$/.test(ref.file) || ref.file.includes('..')) throw new Error('Invalid image ID');
            const info = await resolve(config, 'get_image', { file: ref.file }, { timeout: 10000 });
            url = qqImageUrl(info?.url);
          }
          const { data, ext } = await download(url, fetcher, Math.min(8 * 1024 * 1024, 16 * 1024 * 1024 - bytes));
          dir ||= await mkdtemp(join(tmpdir(), 'linux-contact-images-'));
          let path = join(dir, `image-${paths.length + 1}.${ext}`);
          await writeFile(path, data, { mode: 0o600 });
          if (ext === 'gif') {
            const converted = join(dir, `image-${paths.length + 1}.png`);
            await convertGif(path, converted);
            await rm(path); path = converted; item.representation = 'gif_first_frame';
          }
          paths.push(path); bytes += data.length;
          item.status = 'attached'; item.attachment = paths.length;
        } catch { item.reason = 'download_or_format_failed'; }
      }
    }
    return { paths, attachments, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
