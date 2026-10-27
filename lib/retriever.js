/**
 * Six-dimension hybrid recall.
 *
 * FinalScore = w_green·G + w_user·U + w_sem·Sim + w_ppr·PPR
 *            + w_imp·(importance/10) + w_rec·R_ebbinghaus
 *
 * Every returned card carries its own score breakdown so the panel and the
 * model can see exactly why a memory surfaced.
 */

import { embed, cosine } from './embed.js'
import { hasLiteralKeyword, scanWindow } from './greenlight.js'
import { ensureGraph, HippocampusGraph } from './graph.js'
import {
  DEFAULT_WEIGHTS,
  blendScore,
  ebbinghausRetention,
  reinforceNote,
  toMillis,
} from './scoring.js'

const MAX_GRAPH_NOTES = 5000

export function formatEvent(event) {
  const who = event.nickname ? `${event.nickname}${event.userId ? ` (${event.platform}:${event.userId})` : ''}` : event.userId || '匿名'
  return `[${who}]: ${event.content}`
}

/** Last N messages of one group/comment thread, oldest first. */
export function recentWindow(store, { platform, scopeId, limit = 3, exclude } = {}) {
  if (!platform && !scopeId) return ''
  const events = store
    .listEvents({ platform, scopeId, limit: limit + 1, order: 'desc' })
    .filter((event) => !exclude || event.content.trim() !== exclude.trim())
    .slice(0, limit)
    .reverse()
  return events.map(formatEvent).join('\n')
}

function scopeFilter(note, { platform, scopeId, scopeMode }) {
  if (scopeMode === 'cross_platform') return true
  if (scopeMode === 'strict') return note.platform === platform && note.scopeId === scopeId
  // shared_global: this group/thread plus anything marked global.
  return (
    note.scopeId === 'global' ||
    note.platform === 'global' ||
    (note.platform === platform && note.scopeId === scopeId)
  )
}

function vectorFor(store, note) {
  const existing = store.getEmbedding(note.id)
  if (existing) return existing
  const generated = embed([note.content, note.contextSummary, ...(note.keywords || [])].join(' '))
  store.putEmbedding(note.id, generated)
  return generated
}

/**
 * Recall the cards that should flash into the current turn.
 * @returns {{items: object[], window: string, weights: object, graph: object}}
 */
export function recall(store, graphCache, options = {}) {
  const platform = options.platform || 'global'
  const scopeId = options.scopeId || 'global'
  const scopeMode = options.scopeMode || 'shared_global'
  const userId = options.userId ? String(options.userId) : null
  const limit = Math.max(1, Math.min(Number(options.limit) || 3, 20))
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) }

  const recent = options.includeRecent === false
    ? ''
    : options.windowText ?? recentWindow(store, {
      platform,
      scopeId,
      limit: options.recentLimit ?? 3,
      exclude: options.query,
    })
  const windowText = [recent, options.query || ''].filter(Boolean).join('\n')

  const allNotes = store.allNotes(MAX_GRAPH_NOTES)
  const live = allNotes.filter((note) => !note.archived)
  const archived = allNotes.filter((note) => note.archived)
  const candidates = live.filter((note) => scopeFilter(note, { platform, scopeId, scopeMode }))

  // Archived cards are asleep until someone literally says their wake word.
  const forced = archived.filter((note) => hasLiteralKeyword(windowText, note))
  const pool = [...candidates, ...forced]

  const graph = ensureGraph(graphCache, store, live)
  const seeds = graph.seedsFromText(windowText, { platform, userId })
  const pprScores = graph.ppr(seeds)
  const green = scanWindow(pool, windowText)
  const queryVector = embed(windowText)
  const vectors = store.allEmbeddings()

  const scored = []
  for (const note of pool) {
    const greenlight = green.get(note.id)
    if (note.archived && !greenlight) continue
    const noteVector = vectors.get(note.id) || vectorFor(store, note)
    const parts = {
      greenlightScore: greenlight?.score ?? 0,
      userMatchScore: userId && (note.relatedUserIds || []).some((id) => String(id) === userId) ? 1 : 0,
      vectorScore: cosine(queryVector, noteVector),
      pprScore: Math.min(1, pprScores.get(note.id) ?? 0),
      importanceScore: Math.min(1, (Number(note.importance) || 1) / 10),
      ebbinghausRetention: ebbinghausRetention(note, now),
    }
    const finalScore = blendScore(parts, weights)
    scored.push({
      note,
      finalScore,
      parts,
      matchedKeywords: greenlight?.matched || [],
      forcedByKeyword: note.archived && Boolean(greenlight),
      greenlightSource: greenlight?.source || null,
    })
  }

  scored.sort((a, b) => b.finalScore - a.finalScore)
  const selected = scored.slice(0, limit).filter((entry) => entry.finalScore >= (options.minScore ?? 0))

  const items = selected.map(({ note, finalScore, parts, matchedKeywords, forcedByKeyword, greenlightSource }) => {
    const healed = options.reinforce === false ? note : reinforceNote(note, now)
    if (options.reinforce !== false) store.putNote(healed)
    return {
      id: note.id,
      platform: note.platform,
      scopeId: note.scopeId,
      strategy: note.strategy,
      content: note.content,
      contextSummary: note.contextSummary,
      keywords: note.keywords,
      tags: note.tags,
      entities: note.entities,
      importance: note.importance,
      strength: Number(healed.strength.toFixed(2)),
      accessCount: healed.accessCount,
      createdAt: note.createdAt,
      lastAccessedAt: healed.lastAccessedAt,
      archived: note.archived,
      forcedByKeyword,
      greenlightSource,
      matchedKeywords,
      score: {
        greenlight_score: round(parts.greenlightScore),
        user_match_score: round(parts.userMatchScore),
        vector_score: round(parts.vectorScore),
        ppr_score: round(parts.pprScore),
        importance_score: round(parts.importanceScore),
        ebbinghaus_retention: round(parts.ebbinghausRetention),
        final_score: round(finalScore),
      },
    }
  })

  return {
    items,
    window: windowText,
    weights,
    graph: graph.stats(),
    poolSize: pool.length,
    considered: allNotes.length,
  }
}

/** Score one card without touching its strength (panel debug view). */
export function previewScores(store, graphCache, options = {}) {
  return recall(store, graphCache, { ...options, reinforce: false })
}

function round(value) {
  return Math.round(value * 10000) / 10000
}

export { HippocampusGraph }
