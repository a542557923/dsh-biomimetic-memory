/**
 * Scoring primitives shared by retrieval, consolidation and the panel.
 *
 * Recency follows MemoryBank's Ebbinghaus form R = exp(-Δt / (λ·S)), the
 * six-dimension blend follows the weights in the specification, and core
 * promotion uses coreScore = 0.6·(importance/10) + 0.4·tanh((S-1)/5).
 */

export const RETENTION_LAMBDA = 5.0
export const ARCHIVE_RETENTION = 0.15
export const ARCHIVE_IMPORTANCE = 6.0
export const DEFAULT_CORE_SIZE = 8

export const DEFAULT_WEIGHTS = Object.freeze({
  green: 0.3,
  user: 0.2,
  semantic: 0.2,
  ppr: 0.1,
  importance: 0.1,
  recency: 0.1,
})

const MS_PER_DAY = 86_400_000

export function toMillis(value, fallback = Date.now()) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Days elapsed since the card was last touched. */
export function daysSince(timestamp, now = Date.now()) {
  return Math.max(0, (now - toMillis(timestamp, now)) / MS_PER_DAY)
}

/** Ebbinghaus retention in (0, 1]. */
export function ebbinghausRetention(note, now = Date.now()) {
  const strength = Math.max(1, Number(note.strength) || 1)
  const elapsed = daysSince(note.lastAccessedAt || note.createdAt, now)
  return Math.exp(-elapsed / (RETENTION_LAMBDA * strength))
}

/** Reinforcement applied when a card is actually injected into a context. */
export function reinforceNote(note, now = Date.now()) {
  const importance = Math.max(1, Math.min(10, Number(note.importance) || 1))
  return {
    ...note,
    strength: (Number(note.strength) || 1) + 0.5 * (1 + importance / 10),
    lastAccessedAt: new Date(now).toISOString(),
    accessCount: (Number(note.accessCount) || 0) + 1,
  }
}

/** Long-term value used for Tier-0 promotion. */
export function coreScore(note) {
  const importance = Math.max(1, Math.min(10, Number(note.importance) || 1))
  const strength = Math.max(1, Number(note.strength) || 1)
  return 0.6 * (importance / 10) + 0.4 * Math.tanh((strength - 1) / 5)
}

export function normalizeWeights(weights = {}) {
  const merged = { ...DEFAULT_WEIGHTS }
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = Number(weights[key])
    if (Number.isFinite(value) && value >= 0) merged[key] = value
  }
  return merged
}

/**
 * Blend the six dimensions.  Inputs are already normalized where the
 * specification defines a range; green-light stays in {0, 1.0, 1.5}.
 */
export function blendScore(parts, weights = DEFAULT_WEIGHTS) {
  const w = normalizeWeights(weights)
  return (
    w.green * parts.greenlightScore +
    w.user * parts.userMatchScore +
    w.semantic * parts.vectorScore +
    w.ppr * parts.pprScore +
    w.importance * parts.importanceScore +
    w.recency * parts.ebbinghausRetention
  )
}

/** Human-readable retention bucket for the panel. */
export function retentionLabel(retention) {
  if (retention >= 0.8) return '清晰'
  if (retention >= 0.5) return '记得'
  if (retention >= 0.25) return '模糊'
  if (retention >= ARCHIVE_RETENTION) return '快忘了'
  return '深层睡眠'
}
