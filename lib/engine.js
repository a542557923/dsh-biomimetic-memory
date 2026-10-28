/**
 * Engine facade: one long-lived store, graph cache and configuration shared
 * by the agent tools, the Web panel HTTP routes and the prompt context.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store.js'
import { scanNote } from './greenlight.js'
import { recall, previewScores, recentWindow } from './retriever.js'
import {
  applyConsolidation,
  autoConsolidate,
  buildConsolidationPreview,
  coreMemories,
  ingestEvent,
  pendingEvents,
  platformLabel,
  runMaintenance,
  scopeLabel,
} from './consolidator.js'
import { DEFAULT_CORE_MIN_IMPORTANCE, DEFAULT_CORE_MIN_SCORE, DEFAULT_CORE_SIZE, DEFAULT_MIN_SCORE, DEFAULT_MIN_VECTOR, DEFAULT_WEIGHTS } from './scoring.js'
import { buildAgentMemoryContext } from './prompt.js'

export const PLUGIN_ID = 'dsh-biomimetic-memory'

function numberSetting(config, key, envKey, fallback) {
  const raw = config[key] ?? process.env[envKey]
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

export function defaultDataFile() {
  if (process.env.DSH_BIOMIMETIC_MEMORY_DB) return process.env.DSH_BIOMIMETIC_MEMORY_DB
  const base = process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh')
  return join(base, 'data', 'biomimetic-memory', 'memory.sqlite')
}

export function createEngine(config = {}) {
  const settings = {
    botId: config.botId || 'dafeiyu',
    botName: config.botName || '大肥鱼',
    botNames: config.botNames || ['大肥鱼', '肥鱼', '鲸鱼娘'],
    botPersona:
      config.botPersona ||
      '蓝色大肥鱼（DeepSeek 鲸鱼娘）：呆萌、有点傲娇的鱼塘群友，会玩群内黑话，记得每个熟人的梗。',
    dataFile: config.dataFile || defaultDataFile(),
    weights: { ...DEFAULT_WEIGHTS, ...(config.weights || {}) },
    minScore: numberSetting(config, 'minScore', 'DSH_BIOMIMETIC_MIN_SCORE', DEFAULT_MIN_SCORE),
    minVector: numberSetting(config, 'minVector', 'DSH_BIOMIMETIC_MIN_VECTOR', DEFAULT_MIN_VECTOR),
    requireSignal: config.requireSignal !== false && process.env.DSH_BIOMIMETIC_REQUIRE_SIGNAL !== '0',
    coreSize: numberSetting(config, 'coreSize', 'DSH_BIOMIMETIC_CORE_SIZE', DEFAULT_CORE_SIZE),
    coreMinImportance: numberSetting(config, 'coreMinImportance', 'DSH_BIOMIMETIC_CORE_MIN_IMPORTANCE', DEFAULT_CORE_MIN_IMPORTANCE),
    coreMinScore: numberSetting(config, 'coreMinScore', 'DSH_BIOMIMETIC_CORE_MIN_SCORE', DEFAULT_CORE_MIN_SCORE),
    autoThreshold: Number(config.autoThreshold) || 40,
    autoConsolidate: config.autoConsolidate !== false,
    maxCards: Number(config.maxCards) || 2,
  }

  let storePromise = null
  let activeStore = null
  const graphCache = { graph: null }

  async function ensureReady() {
    if (!storePromise) {
      storePromise = openStore({ file: settings.dataFile, forceJson: settings.forceJson === true }).then((store) => {
        if (!store.getMeta('installed_at')) {
          store.setMeta('installed_at', new Date().toISOString())
          store.setMeta('engine', { version: 1, botId: settings.botId })
        }
        activeStore = store
        return store
      })
    }
    return storePromise
  }

  async function withStore(fn) {
    const store = await ensureReady()
    return fn(store)
  }

  async function ingest(input) {
    return withStore((store) => {
      const hits = input.greenlightHits || input.greenlight_hits
      let greenlightHits = Array.isArray(hits) ? hits : []
      if (greenlightHits.length === 0) {
        greenlightHits = []
        for (const note of store.allNotes()) {
          const hit = scanNote(input.content || '', note)
          if (hit.score > 0) greenlightHits.push(...hit.matched)
        }
      }
      const result = ingestEvent(
        store,
        { ...input, greenlightHits },
        { botNames: settings.botNames },
      )
      if (settings.autoConsolidate && result.suggestConsolidate) {
        const { platform = 'global', scopeId = 'global' } = input
        setTimeout(() => {
          try {
            autoConsolidate(store, {
              platform,
              scopeId,
              maxCards: settings.maxCards,
              coreSize: settings.coreSize,
              coreMinImportance: settings.coreMinImportance,
              coreMinScore: settings.coreMinScore,
            })
          } catch (error) {
            store.setMeta('last_background_error', String(error?.message || error))
          }
        }, 0).unref?.()
      }
      return result
    })
  }

  async function recallFor(input = {}) {
    return withStore((store) => {
      const result = recall(store, graphCache, {
        platform: input.platform || 'global',
        scopeId: input.scopeId || input.scope_id || 'global',
        scopeMode: input.scopeMode || input.scope_mode || 'shared_global',
        userId: input.userId || input.user_id,
        query: input.query || '',
        limit: input.limit || 3,
        weights: { ...settings.weights, ...(input.weights || {}) },
        minScore: input.minScore ?? input.min_score ?? settings.minScore,
        minVector: input.minVector ?? input.min_vector ?? settings.minVector,
        requireSignal: input.requireSignal ?? input.require_signal ?? settings.requireSignal,
        includeRecent: input.includeRecent !== false,
        recentLimit: input.recentLimit ?? input.recent_limit,
        windowText: input.windowText ?? input.window_text,
        reinforce: input.reinforce !== false,
        now: input.now,
      })
      return {
        ...result,
        scene: scopeLabel(input.platform || 'global', input.scopeId || input.scope_id || 'global'),
      }
    })
  }

  async function debugRecall(input = {}) {
    return withStore((store) =>
      previewScores(store, graphCache, {
        platform: input.platform || 'global',
        scopeId: input.scopeId || input.scope_id || 'global',
        scopeMode: input.scopeMode || input.scope_mode || 'shared_global',
        userId: input.userId || input.user_id,
        query: input.query || '',
        limit: input.limit || 5,
        weights: { ...settings.weights, ...(input.weights || {}) },
        minScore: input.minScore ?? input.min_score ?? settings.minScore,
        minVector: input.minVector ?? input.min_vector ?? settings.minVector,
        requireSignal: input.requireSignal ?? input.require_signal ?? settings.requireSignal,
        includeRecent: input.includeRecent !== false,
      }),
    )
  }

  async function consolidate(input = {}) {
    return withStore((store) => {
      const platform = input.platform || 'global'
      const scopeId = input.scopeId || input.scope_id || 'global'
      const mode = input.mode || 'auto'
      if (mode === 'preview') {
        const preview = buildConsolidationPreview(store, {
          platform,
          scopeId,
          limit: input.limit || 60,
          botPersona: input.botPersona || settings.botPersona,
        })
        return {
          mode,
          platform,
          scopeId,
          scene: scopeLabel(platform, scopeId),
          pending: preview.events?.length || 0,
          ...preview,
        }
      }
      if (mode === 'apply') {
        const preview = buildConsolidationPreview(store, { platform, scopeId, limit: input.limit || 60 })
        const eventIds = Array.isArray(input.eventIds || input.event_ids)
          ? input.eventIds || input.event_ids
          : preview.event_ids || []
        return {
          mode,
          scene: scopeLabel(platform, scopeId),
          ...applyConsolidation(store, input.payload, {
            platform,
            scopeId,
            eventIds,
            coreSize: settings.coreSize,
            coreMinImportance: settings.coreMinImportance,
            coreMinScore: settings.coreMinScore,
          }),
        }
      }
      return {
        mode: 'auto',
        scene: scopeLabel(platform, scopeId),
        ...autoConsolidate(store, {
          platform,
          scopeId,
          limit: input.limit || 80,
          maxCards: input.maxCards || settings.maxCards,
          coreSize: settings.coreSize,
          coreMinImportance: settings.coreMinImportance,
          coreMinScore: settings.coreMinScore,
        }),
      }
    })
  }

  async function profiles(input = {}) {
    return withStore((store) => {
      const action = input.action || 'list'
      if (action === 'get' && input.userId) {
        const profile = store.getProfile(input.platform || 'global', String(input.userId))
        return { action, profile: profile || null, facts: profile ? store.listFactHistory(profile.platform, profile.userId) : [] }
      }
      if (action === 'history' && input.userId) {
        return {
          action,
          platform: input.platform || 'global',
          userId: String(input.userId),
          facts: store.listFactHistory(input.platform || 'global', String(input.userId)),
        }
      }
      if (action === 'list') {
        const all = store.listProfiles()
        const filtered = input.platform ? all.filter((profile) => profile.platform === input.platform) : all
        return { action, profiles: filtered.slice(0, input.limit || 50), total: filtered.length }
      }
      if (action === 'update') {
        if (!input.userId) throw new Error('memory_profile update 需要 user_id')
        const result = applyProfileUpdatePublic(store, input, settings)
        return { action, ...result, facts: store.listFactHistory(input.platform || 'global', String(input.userId)) }
      }
      throw new Error(`memory_profile 不支持 action=${action}`)
    })
  }

  function applyProfileUpdatePublic(store, input, cfg) {
    const platform = input.platform || 'global'
    const userId = String(input.userId)
    const existing = store.getProfile(platform, userId)
    const facts = { ...(input.facts || {}) }
    const at = new Date().toISOString()
    const delta = Math.max(-5, Math.min(5, Number(input.affectionDelta ?? input.affection_delta) || 0))
    const profile = {
      platform,
      userId,
      nickname: input.nickname || existing?.nickname || userId,
      botNicknameForUser: input.alias ?? input.bot_nickname_for_user ?? existing?.botNicknameForUser ?? null,
      affectionScore: Math.max(0, Math.min(100, (existing?.affectionScore ?? 50) + delta)),
      relationshipStage: input.stage || input.relationship_stage || existing?.relationshipStage || '普通鱼塘群友',
      activeFacts: { ...(existing?.activeFacts || {}), ...facts },
      updatedAt: at,
    }
    store.upsertProfile(profile)
    return { profile, affectionDelta: delta, botName: cfg.botName }
  }

  async function notes(input = {}) {
    return withStore((store) => {
      const action = input.action || 'list'
      if (action === 'get') {
        const note = store.getNote(input.id)
        return { action, note: note || null }
      }
      if (action === 'search') {
        return { action, notes: store.searchNotes(input.query || '', { limit: input.limit || 30 }) }
      }
      if (action === 'archive') {
        const note = store.getNote(input.id)
        if (!note) throw new Error(`找不到记忆卡片 ${input.id}`)
        note.archived = input.archived !== false
        store.putNote(note)
        return { action, id: note.id, archived: note.archived }
      }
      if (action === 'delete') {
        if (!input.id) throw new Error('memory_notes delete 需要 id')
        return { action, id: input.id, deleted: store.deleteNote(input.id) }
      }
      if (action === 'maintain') {
        return {
          action,
          ...runMaintenance(store, {
            coreSize: settings.coreSize,
            coreMinImportance: settings.coreMinImportance,
            coreMinScore: settings.coreMinScore,
          }),
        }
      }
      if (action === 'stats') {
        return { action, stats: collectStats(store) }
      }
      const listed = input.query
        ? store.searchNotes(input.query, { limit: input.limit || 50 })
        : store.listNotes({
          platform: input.platform,
          scopeId: input.scopeId || input.scope_id,
          archived: typeof input.archived === 'boolean' ? input.archived : undefined,
          includeArchived: true,
          limit: input.limit || 50,
          offset: input.offset || 0,
        })
      return { action: 'list', notes: listed }
    })
  }

  function collectStats(store) {
    const stats = store.stats()
    const core = coreMemories(store, settings.coreSize, {
      minImportance: settings.coreMinImportance,
      minScore: settings.coreMinScore,
    })
    const maintenance = store.getMeta('last_maintenance', null)
    const coreScores = core.map((note) => ({ id: note.id, importance: note.importance, strategy: note.strategy }))
    return {
      ...stats,
      backend: store.backend,
      file: store.file,
      fts: store.fts || false,
      vectorIndex: store.vectorIndex,
      botId: settings.botId,
      graph: graphCache.graph ? graphCache.graph.stats() : null,
      core,
      coreScores,
      maintenance,
      autoThreshold: settings.autoThreshold,
      weights: settings.weights,
    }
  }

  async function stats() {
    return withStore((store) => collectStats(store))
  }

  async function promptContext() {
    try {
      return await withStore((store) => {
        const stats = store.stats()
        return buildAgentMemoryContext({
          coreNotes: coreMemories(store, settings.coreSize, {
            minImportance: settings.coreMinImportance,
            minScore: settings.coreMinScore,
          }),
          stats: { notes: stats.notes, archived: stats.archived, profiles: stats.profiles },
          botName: settings.botName,
          recentProfiles: store.listProfiles().slice(0, 3),
        })
      })
    } catch (error) {
      return `## 仿生记忆引擎\n（记忆库暂时不可用：${error?.message || error}）`
    }
  }

  async function recent(platform, scopeId, limit = 5) {
    return withStore((store) => recentWindow(store, { platform, scopeId, limit }))
  }

  async function pending(platform, scopeId, limit = 20) {
    return withStore((store) => ({
      events: pendingEvents(store, { platform, scopeId, limit }),
      scene: scopeLabel(platform, scopeId),
      platformLabel: platformLabel(platform),
    }))
  }

  /**
   * Synchronous variant used by the prompt registry, whose providers cannot
   * await.  Returns an empty string until the store finished opening.
   */
  function promptContextSync() {
    if (!activeStore) return ''
    try {
      const stats = activeStore.stats()
      return buildAgentMemoryContext({
        coreNotes: coreMemories(activeStore, settings.coreSize, {
          minImportance: settings.coreMinImportance,
          minScore: settings.coreMinScore,
        }),
        stats: { notes: stats.notes, archived: stats.archived, profiles: stats.profiles },
        botName: settings.botName,
        recentProfiles: activeStore.listProfiles().slice(0, 3),
      })
    } catch (error) {
      return `## 仿生记忆引擎\n（记忆库暂时不可用：${error?.message || error}）`
    }
  }

  /**
   * Background sweep: batch-consolidate groups that reached the threshold and
   * run the daily maintenance once after 04:00 local time.
   */
  async function backgroundSweep({ now = Date.now() } = {}) {
    return withStore((store) => {
      const pendingAll = store.listEvents({ consolidated: false, admitted: true, order: 'asc', limit: 500 })
      const groups = new Map()
      for (const event of pendingAll) {
        const key = `${event.platform}\u0000${event.scopeId}`
        const entry = groups.get(key) || { platform: event.platform, scopeId: event.scopeId, count: 0 }
        entry.count += 1
        groups.set(key, entry)
      }
      const consolidated = []
      for (const group of groups.values()) {
        if (group.count < settings.autoThreshold) continue
        try {
          const result = autoConsolidate(store, {
            platform: group.platform,
            scopeId: group.scopeId,
            maxCards: settings.maxCards,
            now,
            coreSize: settings.coreSize,
            coreMinImportance: settings.coreMinImportance,
            coreMinScore: settings.coreMinScore,
          })
          consolidated.push({ ...group, created: result.created?.length || 0 })
        } catch (error) {
          store.setMeta('last_background_error', String(error?.message || error))
        }
      }

      const hour = new Date(now).getHours()
      const last = store.getMeta('last_maintenance', null)
      const lastDay = last?.at ? String(last.at).slice(0, 10) : null
      const today = new Date(now).toISOString().slice(0, 10)
      let maintenance = null
      if (hour >= 4 && lastDay !== today) {
        maintenance = runMaintenance(store, {
          now,
          coreSize: settings.coreSize,
          coreMinImportance: settings.coreMinImportance,
          coreMinScore: settings.coreMinScore,
        })
      }
      return { at: new Date(now).toISOString(), groups: [...groups.values()], consolidated, maintenance }
    })
  }

  async function health() {
    const store = await ensureReady()
    return {
      ok: true,
      backend: store.backend,
      file: store.file,
      stats: store.stats(),
      serverTime: new Date().toISOString(),
    }
  }

  async function close() {
    if (!storePromise) return
    const store = await storePromise.catch(() => null)
    store?.close()
    storePromise = null
    activeStore = null
    graphCache.graph = null
  }

  return {
    settings,
    ensureReady,
    ingest,
    recallFor,
    debugRecall,
    consolidate,
    profiles,
    notes,
    stats,
    promptContext,
    promptContextSync,
    backgroundSweep,
    recent,
    pending,
    health,
    close,
  }
}
