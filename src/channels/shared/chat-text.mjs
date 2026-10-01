const FINAL_MARKER = '<<COMPANION_FINAL>>';
const FAIL_CLOSED_REPLY = '我刚刚有点跑题了，你再跟我说说？';

// These are deliberately grouped by meaning rather than by one exact prompt phrase.
// A leak must look like a model discussing how to answer, not merely mention a
// normal conversational word such as “用户问” or “比如”.
const DIRECT_META_OPENER = /^(?:那我应该|我应该回应|回应要)/;
const PLANNING_SIGNALS = [
  /(?:需要|应该|要用|要以|要贴合|回应)/,
  /(?:比如|或者|例如)/,
  /(?:自然|口语化|像聊天|聊天感|别太(?:绕|学术)|简短)/,
  /(?:记得|结合(?:之前|上文)|共情|接住(?:情绪)?)/,
  /(?:这样(?:既|更)?|符合(?:聊天|语气))/,
];

// The model often appends the actual bubble after a final meta sentence. Keep
// this intentionally broad: the confidence gate above prevents ordinary prose
// from being split at a coincidental “这样”。
const PLANNING_BOUNDARY = /(?:自然一点\s*[，,]?\s*像聊天|要口语化\s*[，,、]?\s*别太(?:学术|绕)|这样[^。！？.!！]{0,96}|符合聊天感)[。！？.!！]\s*/g;

function highConfidenceDraft(value) {
  const startsAsMeta = DIRECT_META_OPENER.test(value)
    || value.startsWith('用户');
  if (!startsAsMeta) return false;
  return PLANNING_SIGNALS.filter((signal) => signal.test(value)).length >= 3;
}

function appendedFinal(value) {
  const boundaries = [...value.matchAll(PLANNING_BOUNDARY)];
  const boundary = boundaries.at(-1);
  if (!boundary) return '';
  const result = value.slice(boundary.index + boundary[0].length).trim();
  if (!result || highConfidenceDraft(result) || /^(?:比如|或者|例如)/.test(result)) return '';
  return result;
}

/**
 * Remove a high-confidence internal drafting preamble accidentally emitted by
 * a model.  Deliberately leaves ambiguous text untouched.
 */
export function cleanCompanionDraft(text) {
  if (typeof text !== 'string') return text;
  const finalMarkerIndex = text.lastIndexOf(FINAL_MARKER);
  if (finalMarkerIndex !== -1) {
    const finalText = text.slice(finalMarkerIndex + FINAL_MARKER.length).trim();
    return finalText || FAIL_CLOSED_REPLY;
  }
  const value = text.replace(/\r\n?/g, '\n').trim();
  if (!value || !highConfidenceDraft(value)) return text;
  return appendedFinal(value) || FAIL_CLOSED_REPLY;
}

export function splitChatText(text, maxChars = 4_000) {
  const value = typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
  if (!value) return text === '' ? [] : [text];
  const chunks = [];
  const paragraphs = (maxChars <= 512 ? value.split(/\n+/) : [value])
    .map((part) => part.trim()).filter(Boolean);
  const naturalBoundary = (remaining) => {
    const prefix = remaining.slice(0, maxChars);
    const minimum = Math.max(4, Math.floor(maxChars * 0.38));
    for (const pattern of [/[。！？!?；;][”’」』】）)]?/g, /[，,、：:…][”’」』】）)]?/g, /\s+/g]) {
      const boundaries = [...prefix.matchAll(pattern)]
        .map((match) => match.index + match[0].length)
        .filter((index) => index >= minimum);
      if (boundaries.length) return boundaries.at(-1);
    }
    return maxChars;
  };
  for (const paragraph of paragraphs) {
    let remaining = paragraph;
    while (remaining.length > maxChars) {
      const splitAt = naturalBoundary(remaining);
      chunks.push(remaining.slice(0, splitAt).trim());
      remaining = remaining.slice(splitAt).replace(/^\s+/, '');
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}
