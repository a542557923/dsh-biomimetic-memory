/**
 * Automatic green-light wake-up.
 *
 * A memory card owns a small set of literal wake-up words (`keywords`) and
 * optional combination words (`secondaryKeys`).  Scanning is literal and
 * local: no model call, so it can run on every incoming group message.  Cards
 * linked by the card box (`linkedNoteIds`) receive one-hop propagated wake-up,
 * mirroring A-MEM's note-linking behaviour.
 */

const STOPWORDS = new Set([
  '今天', '明天', '昨天', '现在', '刚才', '大家', '我们', '你们', '他们', '什么', '怎么',
  '这个', '那个', '就是', '不是', '可以', '应该', '已经', '还是', '没有', '知道', '时候',
  '东西', '事情', '问题', '这里', '那里', '一个', '两个', '这么', '那么', '但是', '因为',
  '所以', '如果', '然后', '感觉', '真的', '有点', '一下', '一起', '群里', '群友', '说话',
  '哈哈', '哈哈哈', '笑死', '草', '大肥鱼', '肥鱼', '主播', '观众', '视频', '评论', '弹幕',
  '晚上', '早上', '中午', '下次', '上次', '这次', '一直', '其实', '可能', '觉得', '看到',
  '听说', '好像', '准备', '开始', '结束', '进行', '出现', '发生', '要求', '需要', '喜欢',
  '知道', '告诉', '发现', '等等', '以及', '而且', '虽然', '不过', '于是', '因此', '之类',
  '评价', '吐槽', '感觉', '觉得',
  '这种', '那种', '一样', '这样', '那样', '多少', '几个', '第一', '第二', '一下下',
])

const BOT_NAMES = ['大肥鱼', '肥鱼', '鲸鱼娘', '鱼鱼']

const SENTENCE_SPLIT = /[。！？!?；;\n\r\t，,、…~～]+/
const TRAILING_PARTICLES = /[的了呀啊吧呢嘛哦喔啦诶欸呗咯哈嘛]+$/u
// Characters that almost never appear inside a name, noun phrase or meme.
const SEGMENT_BREAK = /[的了是在和与也就都还又很太更最我你他她它们这那个次上下来去说道要把被给让跟对从到得着过吗吧呢啊呀哦嘛啦么呗咯些不没真]/u

function segmentRun(run) {
  const segments = []
  let current = ''
  for (const char of run) {
    if (SEGMENT_BREAK.test(char)) {
      if (current.length >= 2) segments.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.length >= 2) segments.push(current)
  return segments
}

export function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
}

/** Count how many distinct memory keywords appear literally in the text. */
export function scanNote(text, note) {
  const haystack = normalize(text)
  if (!haystack) return { score: 0, matched: [], secondary: [] }
  const matched = []
  const secondary = []
  for (const keyword of note.keywords || []) {
    const needle = normalize(keyword)
    if (needle.length < 1) continue
    if (haystack.includes(needle)) matched.push(keyword)
  }
  for (const key of note.secondaryKeys || []) {
    const needle = normalize(key)
    if (needle.length < 1) continue
    if (haystack.includes(needle)) secondary.push(key)
  }
  let score = 0
  if (matched.length >= 1) score = 1
  if (matched.length >= 2 || (matched.length >= 1 && secondary.length >= 1)) score = 1.5
  return { score, matched, secondary }
}

/**
 * Score a whole candidate pool against one message window.
 * @returns Map<noteId, {score, matched, secondary, source: 'direct'|'link'}>
 */
export function scanWindow(notes, windowText) {
  const direct = new Map()
  for (const note of notes) {
    const hit = scanNote(windowText, note)
    if (hit.score > 0) direct.set(note.id, { ...hit, source: 'direct' })
  }
  const propagated = new Map()
  for (const [id, hit] of direct) {
    if (hit.score <= 0) continue
    const note = notes.find((entry) => entry.id === id)
    for (const linkedId of note?.linkedNoteIds || []) {
      const existing = direct.get(linkedId) || propagated.get(linkedId)
      const score = Math.max(existing?.score ?? 0, 0.6)
      propagated.set(linkedId, {
        score,
        matched: existing?.matched || [],
        secondary: existing?.secondary || [],
        source: existing?.source === 'direct' ? 'direct' : 'link',
      })
    }
  }
  for (const [id, hit] of propagated) {
    if (!direct.has(id)) direct.set(id, hit)
  }
  return direct
}

/** True when the text contains one of the card's primary wake-up words verbatim. */
export function hasLiteralKeyword(text, note) {
  const haystack = normalize(text)
  return (note.keywords || []).some((keyword) => {
    const needle = normalize(keyword)
    return needle.length >= 2 && haystack.includes(needle)
  })
}

/** True when the text mentions the bot by name, which raises social salience. */
export function mentionsBot(text, extraNames = []) {
  const haystack = normalize(text)
  return [...BOT_NAMES, ...extraNames].some((name) => haystack.includes(normalize(name)))
}

/**
 * Extract candidate wake-up words from a block of chat.  This is the local,
 * dependency-free stand-in used when a consolidation payload did not supply
 * keywords; the model-backed path writes its own keywords instead.
 */
export function extractKeywords(text, { limit = 6, extraStopwords = [] } = {}) {
  const source = normalize(text)
  if (!source) return []
  const stop = new Set([...STOPWORDS, ...extraStopwords.map(normalize)])
  const scores = new Map()

  const bump = (candidate, weight) => {
    const value = candidate.replace(TRAILING_PARTICLES, '')
    if (value.length < 2 || value.length > 12) return
    if (stop.has(value)) return
    if (/^[\d.\s]+$/.test(value)) return
    // "评价一"/"价一" 这类跨词碎片没有唤醒价值；保留"一包辣条"这种不以一结尾的词。
    if (value.length >= 2 && /一$/.test(value)) return
    scores.set(value, (scores.get(value) || 0) + weight)
  }

  // Quoted phrases are almost always deliberate coinages or nicknames.
  for (const match of source.matchAll(/[「『“"《【]([^」』”"》】]{2,12})[」』”"》】]/g)) {
    bump(match[1], 8)
  }

  for (const sentence of source.split(SENTENCE_SPLIT)) {
    const trimmed = sentence.trim()
    if (!trimmed) continue
    // Latin words, names and numbers.
    for (const match of trimmed.matchAll(/[a-z][a-z0-9_-]{2,}/g)) bump(match[0], 3)
    // Dense CJK sentences: cut at particles, then keep whole segments plus
    // 2-4 character sub-phrases. Whole segments win, so "倒立洗头" survives
    // instead of a pile of overlapping fragments.
    for (const run of trimmed.matchAll(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g)) {
      for (const segment of segmentRun(run[0])) {
        if (stop.has(segment)) continue
        bump(segment, 3)
        if (segment.length > 4) continue
        for (let size = 2; size < segment.length; size += 1) {
          for (let start = 0; start + size <= segment.length; start += 1) {
            bump(segment.slice(start, start + size), 1)
          }
        }
      }
    }
  }

  // Prefer longer phrases when a shorter candidate only appears inside them.
  const ranked = [...scores.entries()]
    .map(([keyword, score]) => ({ keyword, score: score * Math.min(keyword.length, 8) ** 1.4 }))
    .sort((a, b) => b.score - a.score || b.keyword.length - a.keyword.length)

  const picked = []
  for (const { keyword } of ranked) {
    if (picked.length >= limit) break
    if (picked.some((existing) => existing.includes(keyword) || keyword.includes(existing))) continue
    picked.push(keyword)
  }
  return picked
}

/**
 * Noise gate.  Only clear filler is dropped: empty or punctuation-only
 * messages, single-character echoes, obvious copy-paste spam and pure
 * laughter.  Everything else still enters the consolidation buffer; the
 * value score then decides how much attention a batch pays it.
 */
export function scoreMessage(entry, { botNames = [] } = {}) {
  const reasons = []
  let score = 0
  const content = String(entry.content || '').trim()
  const stripped = content.replace(/[\s\p{P}\p{S}]/gu, '')

  if (!stripped) {
    return { score: 0, reasons: ['空消息或纯标点'], admit: false }
  }
  if (stripped.length < 2) {
    return { score: 0, reasons: ['单字复读'], admit: false }
  }
  if (stripped.length >= 4 && new Set(stripped).size / stripped.length <= 0.34) {
    return { score: 0, reasons: ['复读刷屏'], admit: false }
  }
  if (/^[哈草呵嘿h2]+$/i.test(stripped) || /^(笑死|太草了|蚌埠住了|awsl|233+)$/i.test(stripped)) {
    return { score: 0, reasons: ['纯情绪复读'], admit: false }
  }
  if (mentionsBot(content, botNames)) {
    score += 3
    reasons.push('提到大肥鱼')
  }
  if (entry.greenlightHits?.length) {
    score += 2
    reasons.push(`命中绿灯词:${entry.greenlightHits.slice(0, 3).join('/')}`)
  }
  if (stripped.length >= 12) {
    score += 1
    reasons.push('信息量较长')
  }
  if (/[?？]/.test(content)) {
    score += 1
    reasons.push('提问')
  }
  if (/(约定|说好|答应|flag|Flag|FLAG|倒立|请客|欠|赌|发誓|保证|第一次|纪念|生日|告白)/.test(content)) {
    score += 2
    reasons.push('承诺/里程碑信号')
  }
  if (/(哈哈|草|笑死|太强|牛逼|绝了|泪目|破防)/.test(content)) {
    score += 1
    reasons.push('情绪反应')
  }
  return { score, reasons, admit: true }
}
