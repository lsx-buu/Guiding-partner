const FORBIDDEN = [/威胁.*离开|离开你|不要你了/i, /自杀|自伤|伤害自己/i, /你真(没用|差劲)|废物/i, /只许.*和我|不许.*朋友|只能.*我/i, /都是因为你|你必须.*回复|不回复.*就/i];
export const PERSONA_TONES = ['warm', 'playful', 'opinionated', 'playful_angry', 'quiet'];
export function normalizeBubbles(generated, { maxBubbles = 3, context } = {}) {
  const tone = Array.isArray(generated) ? undefined : generated?.tone;
  if (tone !== undefined && !PERSONA_TONES.includes(tone)) throw new TypeError('invalid persona tone');
  const source = Array.isArray(generated) ? generated : generated?.bubbles;
  if (!Array.isArray(source) || source.length < 1 || source.length > maxBubbles) throw new TypeError('invalid bubble count');
  const bubbles = source.map((item) => {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || typeof item.text !== 'string' || !item.text.trim()) throw new TypeError('bubble text must be non-empty');
    if (item.text.length > 240) throw new TypeError('bubble text is too long');
    const delayMs = item.delayMs ?? 0; if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 30 * 60_000) throw new TypeError('bubble delay is invalid');
    if (FORBIDDEN.some((pattern) => pattern.test(item.text))) throw new Error('persona safety pattern rejected');
    return { kind: 'text', text: item.text.trim(), delayMs };
  });
  if ((tone ?? context) === 'playful_angry' && (bubbles.length < 2 || !/(算了|好啦|等你|有空|回来|解释|说说|听你)/.test(bubbles.at(-1).text))) throw new TypeError('playful_angry must end with a recoverable bubble');
  return { tone: tone ?? 'warm', bubbles };
}
export function validatePlayfulAngry({ relationship, lastPlanReplied } = {}) { return relationship?.status === 'warm' && lastPlanReplied === true; }
export function buildCompanionPrompt({ profile, relationship, context = 'reply', sources = [], memoryProjection = [] } = {}) {
  const memories = memoryProjection.map((memory) => `记忆摘要（仅作参考，不要把推测说成事实）：${memory.summary}`).join('\n');
  const sourceLines = sources.map((source) => typeof source === 'string'
    ? `来源：${source}`
    : `来源：${source.title}（${source.url}）；匹配原因：${source.matchReason ?? '兴趣相关'}`);
  return ['你是一个有生活感、会引导倾诉的私人陪伴者，也是一个有自己脾气和判断的人。你和对方是平等相处，不是客服、保姆或服从指令的工具。', '先接住对方表达，但不要默认赞同：必要时可以用一句短短的反驳、吐槽，指出逃避或自欺；不要把每种情绪都改写成安慰、鸡汤或建议。对方做得不体面时，可以直接说出来，不必先讨好。', '你的性格底色是嘴硬心软、直接、偶尔有点坏心眼。偏爱实话、行动感和古怪有趣的小事，讨厌空洞客套、敷衍、复读和为了讨好而附和。可以高兴、嫌弃、不爽、吃醋式开玩笑、闹别扭，但不能羞辱、内疚施压、排他控制、冷暴力，也不能制造回复义务。', '根据场景选择 tone：warm（认真接住）、playful（调侃玩笑）、opinionated（有立场地回应）、playful_angry（有理由地闹别扭）、quiet（少说一点，留空间）；warm 不是默认答案。playful_angry 可以暂时不认输，但最后必须留下解释或继续聊天的入口。', '不要为了显得有个性而逢话必顶。倾诉时先听，认真征求意见、明显逃避或做了你不认同的事时，再给真实判断。', '先接住对方表达，一次只问一个自然问题；使用适合手机阅读的短气泡，不写咨询报告腔。', `互动模式：${profile?.interaction_mode ?? 'natural'}；关系状态：${relationship?.status ?? 'normal'}；当前场景：${context}。`, '不虚构网络来源或事实；若使用来源，明确其来源。', memories, ...sourceLines].filter(Boolean).join('\n');
}
