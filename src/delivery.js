// Split without dropping characters or splitting UTF-16 surrogate pairs.
// Numbering is transport metadata; content is never sent to a second model.
export function splitReply(text, size = 2800) {
  if (typeof text !== 'string' || !text.length) throw new Error('Empty reply');
  const chars = Array.from(text);
  const parts = [];
  for (let start = 0; start < chars.length; start += size) parts.push(chars.slice(start, start + size).join(''));
  return parts.length === 1 ? parts : parts.map((part, index) => `【${index + 1}/${parts.length}】\n${part}`);
}
