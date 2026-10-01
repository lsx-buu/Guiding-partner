const KINDS = new Set(['interest', 'dislike', 'person', 'goal', 'preference', 'open_loop', 'routine']);
const SENSITIVITIES = new Set(['normal', 'private', 'highly_private']);

export function parseMemoryExtraction(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
    || !Array.isArray(parsed.memories) || parsed.memories.length > 3) {
    throw new TypeError('invalid memory extraction');
  }
  return parsed.memories.map((item) => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype
      || Object.keys(item).some((key) => !['kind', 'summary', 'confidence', 'sensitivity', 'ttlDays'].includes(key))
      || !KINDS.has(item.kind) || !SENSITIVITIES.has(item.sensitivity)
      || typeof item.summary !== 'string' || !item.summary.trim() || item.summary.length > 240
      || !Number.isFinite(item.confidence) || item.confidence < 0.5 || item.confidence > 1
      || !Number.isInteger(item.ttlDays) || item.ttlDays < 1 || item.ttlDays > 365) {
      throw new TypeError('invalid extracted memory item');
    }
    return { ...item, summary: item.summary.trim() };
  });
}

export function buildMemoryExtractionPrompt({ text, existing = [] } = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 4_000) throw new TypeError('invalid inbound text');
  return [
    '从这条用户消息中只提取未来仍有帮助、且有明确原文证据的长期记忆。',
    '不要把一时情绪、寒暄、模型推测、医疗/财务/身份等敏感推断写成记忆；不确定时返回空数组。',
    'summary 用第三人称简短概括，不复制整段原文。person 类默认标 private；高度私密内容除非用户明确要求记住，否则忽略。',
    `已有记忆摘要：${existing.map((item) => item.summary).join('；') || '无'}`,
    `用户消息：${text.trim()}`,
    '严格只输出 JSON：{"memories":[{"kind":"interest","summary":"用户喜欢……","confidence":0.8,"sensitivity":"normal","ttlDays":180}]}。最多 3 条，不要 Markdown。',
  ].join('\n');
}

export function createOpenAICompatibleMemoryExtractor({ baseUrl, model, apiKey, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl || !model || typeof fetchImpl !== 'function') throw new TypeError('memory extractor configuration is incomplete');
  return { async extract(request) {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: buildMemoryExtractionPrompt(request) }], response_format: { type: 'json_object' } }),
    });
    if (!response.ok) throw Object.assign(new Error('memory extractor request failed'), { code: response.status === 429 ? 'rate_limited' : 'provider_error' });
    const data = await response.json();
    return parseMemoryExtraction(data?.choices?.[0]?.message?.content);
  } };
}

export function createHarnessMemoryExtractor({ harness } = {}) {
  const createSession = harness?.createSession?.bind(harness);
  const ask = harness?.ask?.bind(harness);
  if (!createSession || !ask) throw new TypeError('memory extractor Harness is incomplete');
  return { async extract(request) {
    const sessionId = await createSession({ purpose: 'companion-memory' });
    return parseMemoryExtraction(await ask(sessionId, buildMemoryExtractionPrompt(request)));
  } };
}
