/**
 * Sleep consolidation: noise gate, batch summarisation, profile overwrite,
 * Ebbinghaus archiving and Tier-0 promotion.
 *
 * Three modes:
 *  - preview: build the exact model input (the specification's consolidation
 *    prompt + the buffered chat) without touching the store.
 *  - apply:   write a model-produced JSON payload back into the card box.
 *  - auto:    local heuristic digestion, so the engine still forms memories
 *    when no model endpoint is configured.
 */

import { randomUUID } from 'node:crypto'
import { embed } from './embed.js'
import { extractKeywords, scoreMessage } from './greenlight.js'
import { CONSOLIDATION_SYSTEM_PROMPT } from './prompt.js'
import {
  ARCHIVE_IMPORTANCE,
  ARCHIVE_RETENTION,
  DEFAULT_CORE_MIN_IMPORTANCE,
  DEFAULT_CORE_MIN_SCORE,
  DEFAULT_CORE_SIZE,
  coreScore,
  ebbinghausRetention,
} from './scoring.js'

const PLATFORM_LABEL = { qq: 'QQ', bilibili: 'B站', douyin: '抖音', global: '全平台' }

const COMMITMENT = /(约定|说好|答应|flag|Flag|FLAG|倒立|请客|欠|赌|发誓|保证|生日|告白|投喂)/
const MILESTONE = /(第一次|纪念|周年|破防|翻车|沉船|歪了|退群|入群|结婚|毕业)/
const INSULT = /(傻|蠢|滚|闭嘴|拉黑|黑名单)/

export function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || platform
}

export function scopeLabel(platform, scopeId) {
  if (!scopeId || scopeId === 'global') return `${platformLabel(platform)}全域`
  return `${platformLabel(platform)}${scopeId.startsWith('group_') ? `群 ${scopeId.slice(6)}` : ` ${scopeId}`}`
}

function isoNow(now = Date.now()) {
  return new Date(now).toISOString()
}

function truncate(text, length = 40) {
  const value = String(text || '').replace(/\s+/g, ' ').trim()
  return value.length > length ? `${value.slice(0, length)}…` : value
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

/** Store one incoming social message behind the noise gate. */
export function ingestEvent(store, input = {}, { botNames = [], now = Date.now() } = {}) {
  const content = String(input.content || '').trim()
  if (!content && !input.image) {
    throw new Error('memory_ingest 需要非空的 content')
  }
  const platform = input.platform || 'global'
  const scopeId = input.scopeId || 'global'
  const entry = {
    botId: input.botId || 'dafeiyu',
    platform,
    scopeId,
    userId: input.userId ? String(input.userId) : null,
    nickname: input.nickname || null,
    content,
    createdAt: isoNow(now),
    meta: input.meta || {},
  }

  const windowText = [
    ...(input.greenlightHits || []),
    content,
  ].join(' ')
  const gate = scoreMessage({ ...entry, greenlightHits: input.greenlightHits }, { botNames })
  entry.admitted = gate.admit
  entry.gateScore = gate.score
  entry.gateReasons = gate.reasons
  if (!gate.admit) {
    entry.meta = { ...entry.meta, windowText }
  }
  const id = store.appendEvent(entry)
  const pending = store.countEvents({ platform, scopeId, consolidated: false, admitted: true })
  return {
    id,
    admitted: entry.admitted,
    gateScore: gate.score,
    gateReasons: gate.reasons,
    pendingAdmitted: pending,
    suggestConsolidate: pending >= 40,
  }
}

/** Pending, admitted messages of one group/thread, oldest first. */
export function pendingEvents(store, { platform = 'global', scopeId = 'global', limit = 60 } = {}) {
  const events = store.listEvents({
    platform,
    scopeId,
    consolidated: false,
    admitted: true,
    order: 'asc',
    limit,
  })
  return events
}

function participants(events) {
  const map = new Map()
  for (const event of events) {
    if (!event.userId) continue
    const key = `${event.platform}:${event.userId}`
    if (!map.has(key)) map.set(key, { platform: event.platform, userId: event.userId, nickname: event.nickname || event.userId, count: 0 })
    const entry = map.get(key)
    entry.count += 1
    if (event.nickname) entry.nickname = event.nickname
  }
  return [...map.values()]
}

function profileSnapshot(store, events) {
  return participants(events).map((person) => {
    const profile = store.getProfile(person.platform, person.userId)
    return {
      platform: person.platform,
      userId: person.userId,
      nickname: profile?.nickname || person.nickname,
      bot_nickname_for_user: profile?.botNicknameForUser || null,
      affection_score: profile?.affectionScore ?? 50,
      relationship_stage: profile?.relationshipStage || '普通鱼塘群友',
      active_facts: profile?.activeFacts || {},
      messages: person.count,
    }
  })
}

/** Model input for the specification's consolidation prompt. */
export function buildConsolidationPreview(store, { platform = 'global', scopeId = 'global', limit = 60, botPersona = '' } = {}) {
  const events = pendingEvents(store, { platform, scopeId, limit })
  if (events.length === 0) {
    return { empty: true, events: [], event_ids: [], user_prompt: '', system_prompt: CONSOLIDATION_SYSTEM_PROMPT }
  }
  const profiles = profileSnapshot(store, events)
  const core = store.allNotes().filter((note) => note.strategy === 'constant' && !note.archived).slice(0, DEFAULT_CORE_SIZE)
  const transcript = events.map((event) => {
    const who = event.nickname ? `${event.nickname}${event.userId ? ` (${event.userId})` : ''}` : event.userId || '匿名'
    return `${who}: ${event.content}`
  })

  const userPrompt = [
    botPersona ? `【Bot 角色设定】\n${botPersona}` : '【Bot 角色设定】蓝色大肥鱼：呆萌傲娇的鱼塘群友，喜欢玩梗。',
    `【相关群友当前画像】\n${profiles.length ? JSON.stringify(profiles, null, 2) : '（新面孔）'}`,
    core.length ? `【已有的核心记忆，避免重复造卡】\n${core.map((note) => `- ${note.content}`).join('\n')}` : '',
    `【近期互动记录（${scopeLabel(platform, scopeId)}）】\n${transcript.join('\n')}`,
    '请按系统提示的三项任务输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n')

  return {
    empty: false,
    system_prompt: CONSOLIDATION_SYSTEM_PROMPT,
    user_prompt: userPrompt,
    events,
    event_ids: events.map((event) => event.id),
    profiles,
    scope: scopeLabel(platform, scopeId),
    transcript,
  }
}

/** ---------------------------- heuristic ---------------------------- */

function clusterEvents(events, maxClusters = 3) {
  const clusters = []
  for (const event of events) {
    const keywords = extractKeywords(event.content, { limit: 5 })
    let target = null
    for (const cluster of clusters) {
      const overlap = keywords.filter((keyword) => cluster.keywords.has(keyword))
      if (overlap.length > 0) {
        target = cluster
        break
      }
    }
    if (!target) {
      target = { events: [], keywords: new Set(), scores: 0 }
      clusters.push(target)
    }
    target.events.push(event)
    target.scores += event.gateScore || 0
    for (const keyword of keywords) target.keywords.add(keyword)
  }
  return clusters
    .sort((a, b) => b.events.length * 2 + b.scores - (a.events.length * 2 + a.scores))
    .slice(0, maxClusters)
}

function heuristicImportance(cluster) {
  const text = cluster.events.map((event) => event.content).join(' ')
  let importance = 3
  importance += Math.min(2.5, cluster.events.length * 0.6)
  importance += (text.match(COMMITMENT) ? 2 : 0)
  importance += (text.match(MILESTONE) ? 1.5 : 0)
  importance += Math.min(1.5, cluster.scores / Math.max(1, cluster.events.length) / 4)
  return clamp(Math.round(importance * 2) / 2, 1, 10)
}

function heuristicTags(cluster) {
  const text = cluster.events.map((event) => event.content).join(' ')
  const tags = []
  if (MILESTONE.test(text) || /黑历史|翻车|丢人/.test(text)) tags.push('群友黑历史')
  if (COMMITMENT.test(text) || /名场面/.test(text)) tags.push('名场面')
  if (/投喂|奶茶|外卖|请客|红包/.test(text)) tags.push('投喂记录')
  if (/B站|视频|直播|弹幕/.test(text)) tags.push('B站热评梗')
  return tags.length ? tags : ['日常互动']
}

function heuristicCard(cluster, { platform, scopeId, now }) {
  const events = cluster.events
  const main = events[0]
  const second = events.find((event) => event.id !== main.id && event.content.length > 4) || events[1]
  const keywords = [...cluster.keywords]
    .filter((keyword) => !/^大肥鱼$/.test(keyword))
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
  const who = (event) => `${event.nickname || event.platform + ':' + (event.userId || '匿名')}`
  const place = scopeLabel(platform, scopeId)
  const topic = keywords.slice(0, 2).join('、')
  const firstQuote = `「${truncate(main.content, 46)}」`
  const secondQuote = second ? `「${truncate(second.content, 40)}」` : ''
  // Keep the local heuristic readable but avoid eight identical sentences:
  // pick one of a few first-person phrasings deterministically per event.
  const variants = [
    `我记得在${place}，${who(main)}说${firstQuote}` +
      (second ? `，${who(second)}还接着聊${secondQuote}` : '') +
      (topic ? `，大家围着「${topic}」闹了一阵。` : '。'),
    `${place}那天聊到${topic ? `「${topic}」` : '一件小事'}：${who(main)}说${firstQuote}` +
      (second ? `，${who(second)}补了一句${secondQuote}` : '') +
      '。',
    `关于${topic ? `「${topic}」` : '日常'}的一件小事：${who(main)}在${place}说${firstQuote}` +
      (second ? `，${who(second)}也接了话${secondQuote}` : '') +
      '。',
  ]
  const content = variants[Math.abs(Number(main.id) || 0) % variants.length]
  const relatedUserIds = uniq(events.map((event) => event.userId).filter(Boolean))
  const entities = [...relatedUserIds.map((id) => `user_${id}`), ...keywords.slice(0, 4)]
  const date = new Date(now).toISOString().slice(5, 10)
  return {
    content,
    contextSummary: `${scopeLabel(platform, scopeId)}关于${keywords.slice(0, 2).join('、') || '日常'}的互动（${date}）`,
    relatedUserIds,
    keywords,
    secondaryKeys: [],
    tags: heuristicTags(cluster),
    strategy: 'selective',
    importance: heuristicImportance(cluster),
    entities,
    linkedNoteIds: [],
  }
}

/** ----------------------------- writing ----------------------------- */

function normaliseKeyList(value, fallback = []) {
  if (Array.isArray(value)) return uniq(value.map((item) => String(item).trim()).filter(Boolean))
  if (typeof value === 'string') {
    return uniq(value.split(/[，,、\s]+/).map((item) => item.trim()).filter(Boolean))
  }
  return fallback
}

function normaliseIds(value) {
  return normaliseKeyList(value).map((item) => String(item))
}

function cardFingerprint(card) {
  const text = [card.platform, card.scopeId, card.content].join('|').toLowerCase()
  return embed(text).slice(0, 24).join(',')
}

/** Find existing cards that share wake words, to build A-MEM links. */
function findLinkCandidates(store, card, limit = 3) {
  const wanted = new Set(card.keywords.map((keyword) => keyword.toLowerCase()))
  if (wanted.size === 0) return []
  const scored = []
  for (const note of store.allNotes()) {
    if (note.id === card.id) continue
    let overlap = 0
    for (const keyword of note.keywords || []) if (wanted.has(keyword.toLowerCase())) overlap += 1
    if (overlap > 0) scored.push({ id: note.id, overlap })
  }
  return scored.sort((a, b) => b.overlap - a.overlap).slice(0, limit).map((entry) => entry.id)
}

function linkBothWays(store, cardId, linkedIds) {
  const card = store.getNote(cardId)
  if (!card) return
  card.linkedNoteIds = uniq([...(card.linkedNoteIds || []), ...linkedIds])
  store.putNote(card)
  for (const id of linkedIds) {
    const other = store.getNote(id)
    if (!other) continue
    if ((other.linkedNoteIds || []).includes(cardId)) continue
    other.linkedNoteIds = uniq([...(other.linkedNoteIds || []), cardId])
    store.putNote(other)
  }
}

function persistCard(store, raw, { platform, scopeId, botId = 'dafeiyu', now = Date.now() }) {
  const content = String(raw.content || '').trim()
  if (!content) return { ok: false, reason: '卡片缺少 content' }
  const duplicate = store
    .allNotes()
    .some((note) => note.scopeId === scopeId && note.platform === platform && note.content.trim() === content)
  if (duplicate) return { ok: false, reason: '内容完全重复，已跳过' }

  const keywords = normaliseKeyList(raw.keywords, []).slice(0, 8)
  const finalKeywords = keywords.length ? keywords : extractKeywords(content, { limit: 5 })
  const card = {
    id: randomUUID(),
    botId,
    platform,
    scopeId,
    relatedUserIds: normaliseIds(raw.related_user_ids ?? raw.relatedUserIds),
    content,
    contextSummary: String(raw.context_summary ?? raw.contextSummary ?? '').trim(),
    keywords: finalKeywords,
    secondaryKeys: normaliseKeyList(raw.secondary_keys ?? raw.secondaryKeys),
    tags: normaliseKeyList(raw.tags, ['日常互动']),
    strategy: raw.strategy === 'constant' ? 'constant' : 'selective',
    importance: clamp(Number(raw.importance) || 5, 1, 10),
    strength: 1,
    accessCount: 0,
    createdAt: isoNow(now),
    lastAccessedAt: isoNow(now),
    linkedNoteIds: normaliseIds(raw.linked_note_ids ?? raw.linkedNoteIds),
    entities: uniq([
      ...normaliseKeyList(raw.entities),
      ...normaliseIds(raw.related_user_ids ?? raw.relatedUserIds).map((id) => `user_${id}`),
      ...finalKeywords.slice(0, 4),
    ]),
    archived: false,
    fingerprint: cardFingerprint({ platform, scopeId, content }),
  }
  store.putNote(card)
  store.putEmbedding(card.id, embed([card.content, card.contextSummary, ...card.keywords].join(' ')))

  const discovered = findLinkCandidates(store, card)
  const links = uniq([...card.linkedNoteIds.filter((id) => store.getNote(id)), ...discovered])
  if (links.length) linkBothWays(store, card.id, links)
  return { ok: true, card, links }
}

function applyProfileUpdate(store, update, { platform, now = Date.now() } = {}) {
  const userId = String(update.user_id ?? update.userId ?? '').trim()
  if (!userId) return { ok: false, reason: '画像更新缺少 user_id' }
  const existing = store.getProfile(platform, userId)
  const facts = update.facts_to_upsert ?? update.factsToUpsert ?? {}
  const cleanFacts = {}
  for (const [key, value] of Object.entries(facts || {})) {
    if (!key) continue
    cleanFacts[String(key)] = String(value)
  }
  const nowIsoText = isoNow(now)
  const delta = clamp(Number(update.affection_delta ?? update.affectionDelta ?? 0) || 0, -5, 5)
  const affection = clamp((existing?.affectionScore ?? 50) + delta, 0, 100)
  const mergedFacts = { ...(existing?.activeFacts || {}), ...cleanFacts }
  const profile = {
    platform,
    userId,
    nickname: String(update.nickname || existing?.nickname || userId),
    botNicknameForUser: update.bot_nickname_for_user ?? update.botNicknameForUser ?? existing?.botNicknameForUser ?? null,
    affectionScore: Math.round(affection * 10) / 10,
    relationshipStage: String(update.relationship_stage ?? update.relationshipStage ?? existing?.relationshipStage ?? '普通鱼塘群友'),
    activeFacts: mergedFacts,
    updatedAt: nowIsoText,
  }
  store.upsertProfile(profile)
  return { ok: true, profile, affectionDelta: delta }
}

function parsePayload(payload) {
  if (!payload) throw new Error('缺少 payload')
  if (typeof payload === 'object') return payload
  const text = String(payload).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`payload 不是合法 JSON：${error.message}`)
  }
}

/** Write a model-produced or manually-authored consolidation payload. */
export function applyConsolidation(
  store,
  payload,
  {
    platform = 'global',
    scopeId = 'global',
    eventIds = [],
    now = Date.now(),
    coreSize = DEFAULT_CORE_SIZE,
    coreMinImportance = DEFAULT_CORE_MIN_IMPORTANCE,
    coreMinScore = DEFAULT_CORE_MIN_SCORE,
  } = {},
) {
  const data = parsePayload(payload)
  const cards = Array.isArray(data.new_memories ?? data.newMemories) ? data.new_memories ?? data.newMemories : []
  const profiles = Array.isArray(data.profile_updates ?? data.profileUpdates) ? data.profile_updates ?? data.profileUpdates : []

  const created = []
  const skipped = []
  const updatedProfiles = []

  for (const raw of cards) {
    const result = persistCard(store, raw, { platform, scopeId, now })
    if (result.ok) created.push({ id: result.card.id, importance: result.card.importance, keywords: result.card.keywords, links: result.links })
    else skipped.push(result.reason)
  }

  for (const update of profiles) {
    const result = applyProfileUpdate(store, update, { platform, now })
    if (result.ok) updatedProfiles.push({ userId: result.profile.userId, affection: result.profile.affectionScore, delta: result.affectionDelta })
  }

  if (eventIds.length) store.markEventsConsolidated(eventIds)
  const maintenance = runMaintenance(store, { now, coreSize, coreMinImportance, coreMinScore })

  return {
    created,
    skipped,
    updatedProfiles,
    maintenance,
    stats: store.stats(),
  }
}

/** Heuristic digestion used when no model payload is supplied. */
export function autoConsolidate(
  store,
  {
    platform = 'global',
    scopeId = 'global',
    limit = 80,
    maxCards = 2,
    now = Date.now(),
    coreSize = DEFAULT_CORE_SIZE,
    coreMinImportance = DEFAULT_CORE_MIN_IMPORTANCE,
    coreMinScore = DEFAULT_CORE_MIN_SCORE,
  } = {},
) {
  const events = pendingEvents(store, { platform, scopeId, limit })
  if (events.length === 0) {
    return { created: [], skipped: [], updatedProfiles: [], reason: '没有待整合的有效消息', stats: store.stats() }
  }
  const clusters = clusterEvents(events, maxCards)
  const created = []
  const skipped = []
  for (const cluster of clusters) {
    const heuristic = heuristicCard(cluster, { platform, scopeId, now })
    const result = persistCard(store, heuristic, { platform, scopeId, now })
    if (result.ok) {
      created.push({ id: result.card.id, importance: result.card.importance, keywords: result.card.keywords, links: result.links })
      for (const person of participants(cluster.events)) {
        const delta = heuristic.importance >= 7 ? 2 : 1
        applyProfileUpdate(
          store,
          {
            user_id: person.userId,
            nickname: person.nickname,
            affection_delta: delta,
            facts_to_upsert: {
              最近活跃: new Date(now).toISOString().slice(0, 10),
              最近话题: result.card.keywords.slice(0, 2).join('、') || '日常闲聊',
            },
          },
          { platform, now },
        )
      }
    } else {
      skipped.push(result.reason)
    }
  }
  store.markEventsConsolidated(events.map((event) => event.id))
  const maintenance = runMaintenance(store, { now, coreSize, coreMinImportance, coreMinScore })
  return {
    created,
    skipped,
    updatedProfiles: store.listProfiles().filter((profile) => profile.platform === platform).map((profile) => ({ userId: profile.userId, affection: profile.affectionScore })),
    eventCount: events.length,
    maintenance,
    stats: store.stats(),
  }
}

/** Daily maintenance: forget, then promote only score-qualified core cards. */
export function runMaintenance(
  store,
  {
    now = Date.now(),
    coreSize = DEFAULT_CORE_SIZE,
    coreMinImportance = DEFAULT_CORE_MIN_IMPORTANCE,
    coreMinScore = DEFAULT_CORE_MIN_SCORE,
  } = {},
) {
  const archived = []
  const live = store.allNotes().filter((note) => !note.archived)
  for (const note of live) {
    const retention = ebbinghausRetention(note, now)
    if (retention < ARCHIVE_RETENTION && Number(note.importance) < ARCHIVE_IMPORTANCE) {
      note.archived = true
      store.putNote(note)
      archived.push({ id: note.id, retention: Math.round(retention * 1000) / 1000 })
    }
  }

  const ranked = store
    .allNotes()
    .filter((note) => !note.archived)
    .map((note) => ({ note, score: coreScore(note) }))
    .filter(({ note, score }) => {
      const importance = Number(note.importance) || 1
      return importance >= coreMinImportance && score >= coreMinScore
    })
    .sort((a, b) => b.score - a.score)
  const keep = new Set(ranked.slice(0, coreSize).map(({ note }) => note.id))
  const promoted = []
  const demoted = []
  for (const note of live) {
    const strategy = keep.has(note.id) ? 'constant' : 'selective'
    if (note.strategy !== strategy) {
      note.strategy = strategy
      store.putNote(note)
      if (strategy === 'constant') promoted.push({ id: note.id, coreScore: Math.round(coreScore(note) * 10000) / 10000 })
      else demoted.push(note.id)
    }
  }

  const meta = {
    at: isoNow(now),
    archived: archived.length,
    promoted: promoted.length,
    demoted: demoted.length,
    coreMinImportance,
    coreMinScore,
  }
  store.setMeta('last_maintenance', meta)
  return { archived, promoted, demoted: demoted.length, at: meta.at, coreSize, coreMinImportance, coreMinScore }
}

/** Core memories for Tier 0, already ordered. */
export function coreMemories(
  store,
  limit = DEFAULT_CORE_SIZE,
  {
    minImportance = DEFAULT_CORE_MIN_IMPORTANCE,
    minScore = DEFAULT_CORE_MIN_SCORE,
  } = {},
) {
  return store
    .allNotes()
    .filter((note) => note.strategy === 'constant' && !note.archived)
    .filter((note) => Number(note.importance) >= minImportance && coreScore(note) >= minScore)
    .sort((a, b) => coreScore(b) - coreScore(a))
    .slice(0, limit)
}

/** Names of users who appear in the most recent cards, for the prompt. */
export function recentlyActiveProfiles(store, limit = 3) {
  return store.listProfiles().slice(0, limit)
}

export { CONSOLIDATION_SYSTEM_PROMPT, parsePayload }
