/**
 * Single-file storage layer.
 *
 * Primary backend: Node's built-in `node:sqlite` (one .sqlite file holding
 * memory cards, the FTS5 index, vectors and social profiles).
 * Fallback backend: one JSON document with the identical interface, used when
 * the runtime has no `node:sqlite` (older Node, or a stripped build).
 *
 * Vectors are always stored as float32 BLOBs and ranked by an exact cosine
 * scan in JavaScript, which is the documented `sqlite-vec` fallback in the
 * specification: correctness first, no native extension required.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EMBED_DIM, decodeVector, encodeVector } from './embed.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  related_user_ids_json TEXT NOT NULL,
  content TEXT NOT NULL,
  context_summary TEXT,
  keywords_json TEXT NOT NULL,
  secondary_keys_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  strategy TEXT NOT NULL DEFAULT 'selective',
  importance REAL NOT NULL,
  strength REAL NOT NULL DEFAULT 1.0,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  linked_note_ids_json TEXT NOT NULL DEFAULT '[]',
  entities_json TEXT NOT NULL DEFAULT '[]',
  is_archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_notes(bot_id, platform, scope_id, strategy, is_archived);
CREATE INDEX IF NOT EXISTS idx_memory_strategy ON memory_notes(bot_id, strategy, is_archived);
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS user_profiles (
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  bot_nickname_for_user TEXT,
  affection_score REAL NOT NULL DEFAULT 50.0,
  relationship_stage TEXT NOT NULL DEFAULT '普通鱼塘群友',
  active_facts_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (platform, user_id)
);
CREATE TABLE IF NOT EXISTS profile_fact_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  user_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  invalid_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fact_history ON profile_fact_history(platform, user_id, fact_key);
CREATE TABLE IF NOT EXISTS memory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  user_id TEXT,
  nickname TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  admitted INTEGER NOT NULL DEFAULT 1,
  gate_score REAL NOT NULL DEFAULT 0,
  gate_reasons_json TEXT NOT NULL DEFAULT '[]',
  consolidated INTEGER NOT NULL DEFAULT 0,
  meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_scope ON memory_events(platform, scope_id, consolidated, id);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const FTS_SCHEMA = (tokenize) => `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
  id UNINDEXED,
  content,
  context_summary,
  keywords_text,
  tags_text,
  tokenize='${tokenize}'
);
`

function jsonParse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function nowIso() {
  return new Date().toISOString()
}

function iso(value) {
  if (!value) return nowIso()
  return value instanceof Date ? value.toISOString() : String(value)
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function noteFromRow(row) {
  return {
    id: row.id,
    botId: row.bot_id,
    platform: row.platform,
    scopeId: row.scope_id,
    relatedUserIds: jsonParse(row.related_user_ids_json, []),
    content: row.content,
    contextSummary: row.context_summary || '',
    keywords: jsonParse(row.keywords_json, []),
    secondaryKeys: jsonParse(row.secondary_keys_json, []),
    tags: jsonParse(row.tags_json, []),
    strategy: row.strategy === 'constant' ? 'constant' : 'selective',
    importance: Number(row.importance) || 1,
    strength: Number(row.strength) || 1,
    accessCount: Number(row.access_count) || 0,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    linkedNoteIds: jsonParse(row.linked_note_ids_json, []),
    entities: jsonParse(row.entities_json, []),
    archived: Boolean(row.is_archived),
  }
}

function profileFromRow(row) {
  return {
    platform: row.platform,
    userId: row.user_id,
    nickname: row.nickname,
    botNicknameForUser: row.bot_nickname_for_user || null,
    affectionScore: Number(row.affection_score) || 0,
    relationshipStage: row.relationship_stage || '',
    activeFacts: jsonParse(row.active_facts_json, {}),
    updatedAt: row.updated_at,
  }
}

function eventFromRow(row) {
  return {
    id: Number(row.id),
    botId: row.bot_id,
    platform: row.platform,
    scopeId: row.scope_id,
    userId: row.user_id || null,
    nickname: row.nickname || null,
    content: row.content,
    createdAt: row.created_at,
    admitted: Boolean(row.admitted),
    gateScore: Number(row.gate_score) || 0,
    gateReasons: jsonParse(row.gate_reasons_json, []),
    consolidated: Boolean(row.consolidated),
    meta: jsonParse(row.meta_json, {}),
  }
}

function eventMatches(event, filter = {}) {
  if (filter.platform && event.platform !== filter.platform) return false
  if (filter.scopeId && event.scopeId !== filter.scopeId) return false
  if (filter.userId && event.userId !== filter.userId) return false
  if (filter.consolidated === true && !event.consolidated) return false
  if (filter.consolidated === false && event.consolidated) return false
  if (filter.admitted === true && !event.admitted) return false
  if (filter.admitted === false && event.admitted) return false
  return true
}

function noteMatches(note, filter = {}) {
  if (filter.platform && note.platform !== filter.platform) return false
  if (filter.scopeId && note.scopeId !== filter.scopeId) return false
  if (filter.strategy && note.strategy !== filter.strategy) return false
  if (filter.archived === true && !note.archived) return false
  if (filter.archived === false && note.archived) return false
  if (filter.includeArchived === false && note.archived) return false
  return true
}

/** ------------------------------- SQLite ------------------------------- */

class SqliteStore {
  constructor(DatabaseSync, file) {
    this.backend = 'sqlite'
    this.file = file
    this.revision = 0
    this.db = new DatabaseSync(file)
    this.lastError = null
    this.fts = false
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec(SCHEMA)
    for (const tokenize of ['trigram', 'unicode61']) {
      try {
        this.db.exec(FTS_SCHEMA(tokenize))
        this.fts = tokenize
        break
      } catch (error) {
        this.lastError = String(error?.message || error)
      }
    }
    this.vectorIndex = 'blob-cosine'
    this.vectorCache = null
    this.stmt = {
      upsertNote: this.db.prepare(`INSERT INTO memory_notes (
        id, bot_id, platform, scope_id, related_user_ids_json, content, context_summary,
        keywords_json, secondary_keys_json, tags_json, strategy, importance, strength,
        access_count, created_at, last_accessed_at, linked_note_ids_json, entities_json, is_archived
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        bot_id=excluded.bot_id, platform=excluded.platform, scope_id=excluded.scope_id,
        related_user_ids_json=excluded.related_user_ids_json, content=excluded.content,
        context_summary=excluded.context_summary, keywords_json=excluded.keywords_json,
        secondary_keys_json=excluded.secondary_keys_json, tags_json=excluded.tags_json,
        strategy=excluded.strategy, importance=excluded.importance, strength=excluded.strength,
        access_count=excluded.access_count, created_at=excluded.created_at,
        last_accessed_at=excluded.last_accessed_at, linked_note_ids_json=excluded.linked_note_ids_json,
        entities_json=excluded.entities_json, is_archived=excluded.is_archived`),
      getNote: this.db.prepare('SELECT * FROM memory_notes WHERE id = ?'),
      deleteNote: this.db.prepare('DELETE FROM memory_notes WHERE id = ?'),
      deleteEmbedding: this.db.prepare('DELETE FROM memory_embeddings WHERE id = ?'),
      countNotes: this.db.prepare('SELECT COUNT(*) AS n FROM memory_notes'),
      countArchived: this.db.prepare('SELECT COUNT(*) AS n FROM memory_notes WHERE is_archived = 1'),
      upsertEmbedding: this.db.prepare('INSERT INTO memory_embeddings (id, dim, vec) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET dim=excluded.dim, vec=excluded.vec'),
      getEmbedding: this.db.prepare('SELECT vec FROM memory_embeddings WHERE id = ?'),
      allEmbeddings: this.db.prepare('SELECT id, vec FROM memory_embeddings'),
      upsertProfile: this.db.prepare(`INSERT INTO user_profiles (
        platform, user_id, nickname, bot_nickname_for_user, affection_score,
        relationship_stage, active_facts_json, updated_at
      ) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(platform, user_id) DO UPDATE SET
        nickname=excluded.nickname, bot_nickname_for_user=excluded.bot_nickname_for_user,
        affection_score=excluded.affection_score, relationship_stage=excluded.relationship_stage,
        active_facts_json=excluded.active_facts_json, updated_at=excluded.updated_at`),
      getProfile: this.db.prepare('SELECT * FROM user_profiles WHERE platform = ? AND user_id = ?'),
      listProfiles: this.db.prepare('SELECT * FROM user_profiles ORDER BY updated_at DESC'),
      insertFact: this.db.prepare('INSERT INTO profile_fact_history (platform, user_id, fact_key, fact_value, valid_from, invalid_at, updated_at) VALUES (?,?,?,?,?,?,?)'),
      closeFact: this.db.prepare('UPDATE profile_fact_history SET invalid_at = ? WHERE platform = ? AND user_id = ? AND fact_key = ? AND invalid_at IS NULL'),
      listFacts: this.db.prepare('SELECT * FROM profile_fact_history WHERE platform = ? AND user_id = ? ORDER BY id ASC'),
      insertEvent: this.db.prepare(`INSERT INTO memory_events (
        bot_id, platform, scope_id, user_id, nickname, content, created_at,
        admitted, gate_score, gate_reasons_json, consolidated, meta_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
      getEvent: this.db.prepare('SELECT * FROM memory_events WHERE id = ?'),
      markConsolidated: this.db.prepare('UPDATE memory_events SET consolidated = 1 WHERE id = ?'),
      countEvents: this.db.prepare('SELECT COUNT(*) AS n FROM memory_events'),
      countPending: this.db.prepare('SELECT COUNT(*) AS n FROM memory_events WHERE consolidated = 0 AND admitted = 1'),
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    }
  }

  bump() {
    this.revision += 1
  }

  putNote(note) {
    this.stmt.upsertNote.run(
      note.id,
      note.botId || 'dafeiyu',
      note.platform || 'global',
      note.scopeId || 'global',
      JSON.stringify(asArray(note.relatedUserIds)),
      note.content,
      note.contextSummary || '',
      JSON.stringify(asArray(note.keywords)),
      JSON.stringify(asArray(note.secondaryKeys)),
      JSON.stringify(asArray(note.tags)),
      note.strategy === 'constant' ? 'constant' : 'selective',
      Number(note.importance) || 1,
      Number(note.strength) || 1,
      Number(note.accessCount) || 0,
      iso(note.createdAt),
      iso(note.lastAccessedAt),
      JSON.stringify(asArray(note.linkedNoteIds)),
      JSON.stringify(asArray(note.entities)),
      note.archived ? 1 : 0,
    )
    this.syncFts(note)
    this.bump()
    return note
  }

  syncFts(note) {
    if (!this.fts) return
    try {
      this.db.prepare('DELETE FROM memory_notes_fts WHERE id = ?').run(note.id)
      this.db.prepare('INSERT INTO memory_notes_fts (id, content, context_summary, keywords_text, tags_text) VALUES (?,?,?,?,?)').run(
        note.id,
        note.content || '',
        note.contextSummary || '',
        asArray(note.keywords).join(' '),
        asArray(note.tags).join(' '),
      )
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.fts = false
    }
  }

  getNote(id) {
    const row = this.stmt.getNote.get(id)
    return row ? noteFromRow(row) : undefined
  }

  deleteNote(id) {
    this.stmt.deleteNote.run(id)
    this.stmt.deleteEmbedding.run(id)
    this.vectorCache?.delete(id)
    if (this.fts) {
      try {
        this.db.prepare('DELETE FROM memory_notes_fts WHERE id = ?').run(id)
      } catch {
        /* index already gone */
      }
    }
    this.bump()
    return true
  }

  listNotes(filter = {}) {
    const where = []
    const params = []
    if (filter.platform) {
      where.push('platform = ?')
      params.push(filter.platform)
    }
    if (filter.scopeId) {
      where.push('scope_id = ?')
      params.push(filter.scopeId)
    }
    if (filter.strategy) {
      where.push('strategy = ?')
      params.push(filter.strategy)
    }
    if (filter.archived === true) where.push('is_archived = 1')
    if (filter.archived === false) where.push('is_archived = 0')
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const order = filter.orderBy === 'importance' ? 'importance DESC, created_at DESC' : 'created_at DESC'
    const limit = Math.min(Number(filter.limit) || 50, 500)
    const offset = Math.max(Number(filter.offset) || 0, 0)
    const rows = this.db
      .prepare(`SELECT * FROM memory_notes ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    return rows.map(noteFromRow)
  }

  allNotes(limit = 2000) {
    const rows = this.db
      .prepare(`SELECT * FROM memory_notes ORDER BY importance DESC, created_at DESC LIMIT ?`)
      .all(Math.min(Number(limit) || 2000, 20000))
    return rows.map(noteFromRow)
  }

  searchNotes(query, filter = {}) {
    const text = String(query || '').trim()
    if (!text) return this.listNotes(filter)
    if (this.fts === 'trigram' && text.length >= 3) {
      try {
        const rows = this.db
          .prepare(`SELECT n.* FROM memory_notes_fts f JOIN memory_notes n ON n.id = f.id
                    WHERE memory_notes_fts MATCH ? ORDER BY rank LIMIT ?`)
          .all(`"${text.replaceAll('"', '""')}"`, Math.min(Number(filter.limit) || 30, 200))
        return rows.map(noteFromRow)
      } catch (error) {
        this.lastError = String(error?.message || error)
      }
    }
    const like = `%${text}%`
    const rows = this.db
      .prepare(`SELECT * FROM memory_notes WHERE content LIKE ? OR context_summary LIKE ?
                OR keywords_json LIKE ? OR tags_json LIKE ? ORDER BY importance DESC LIMIT ?`)
      .all(like, like, like, like, Math.min(Number(filter.limit) || 30, 200))
    return rows.map(noteFromRow)
  }

  countNotes(filter = {}) {
    const all = Number(this.stmt.countNotes.get().n)
    if (!filter || Object.keys(filter).length === 0) return all
    return this.listNotes({ ...filter, limit: 500 }).length
  }

  stats() {
    const notes = Number(this.stmt.countNotes.get().n)
    const archived = Number(this.stmt.countArchived.get().n)
    const events = Number(this.stmt.countEvents.get().n)
    const pending = Number(this.stmt.countPending.get().n)
    const profiles = this.db.prepare('SELECT COUNT(*) AS n FROM user_profiles').get().n
    const vectors = this.db.prepare('SELECT COUNT(*) AS n FROM memory_embeddings').get().n
    return { notes, archived, events, pendingEvents: pending, profiles: Number(profiles), vectors: Number(vectors) }
  }

  putEmbedding(id, vec) {
    this.stmt.upsertEmbedding.run(id, vec.length, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength))
    this.vectorCache?.set(id, vec)
    this.bump()
  }

  getEmbedding(id) {
    const row = this.stmt.getEmbedding.get(id)
    return row ? decodeVector(row.vec) : null
  }

  allEmbeddings() {
    if (this.vectorCache) return this.vectorCache
    const map = new Map()
    for (const row of this.stmt.allEmbeddings.all()) {
      const vec = decodeVector(row.vec)
      if (vec) map.set(row.id, vec)
    }
    this.vectorCache = map
    return map
  }

  upsertProfile(profile) {
    const previous = this.getProfile(profile.platform, profile.userId)
    const at = iso(profile.updatedAt)
    const nextFacts = profile.activeFacts || {}
    for (const [key, value] of Object.entries(nextFacts)) {
      if (String((previous?.activeFacts || {})[key]) === String(value)) continue
      this.stmt.closeFact.run(at, profile.platform, profile.userId, key)
      this.stmt.insertFact.run(profile.platform, profile.userId, key, String(value), at, null, at)
    }
    this.stmt.upsertProfile.run(
      profile.platform,
      profile.userId,
      profile.nickname || previous?.nickname || profile.userId,
      profile.botNicknameForUser ?? previous?.botNicknameForUser ?? null,
      Number(profile.affectionScore) || 0,
      profile.relationshipStage || previous?.relationshipStage || '普通鱼塘群友',
      JSON.stringify(nextFacts),
      at,
    )
    this.bump()
    return profile
  }

  getProfile(platform, userId) {
    const row = this.stmt.getProfile.get(platform, userId)
    return row ? profileFromRow(row) : undefined
  }

  listProfiles() {
    return this.stmt.listProfiles.all().map(profileFromRow)
  }

  replaceFacts(platform, userId, facts, at = nowIso()) {
    const current = this.getProfile(platform, userId)?.activeFacts || {}
    for (const [key, value] of Object.entries(facts)) {
      if (current[key] === value) continue
      this.stmt.closeFact.run(at, platform, userId, key)
      this.stmt.insertFact.run(platform, userId, key, String(value), at, null, at)
    }
  }

  listFactHistory(platform, userId) {
    return this.stmt.listFacts.all(platform, userId).map((row) => ({
      key: row.fact_key,
      value: row.fact_value,
      validFrom: row.valid_from,
      invalidAt: row.invalid_at,
      updatedAt: row.updated_at,
    }))
  }

  appendEvent(event) {
    const result = this.stmt.insertEvent.run(
      event.botId || 'dafeiyu',
      event.platform,
      event.scopeId,
      event.userId || null,
      event.nickname || null,
      event.content,
      iso(event.createdAt),
      event.admitted === false ? 0 : 1,
      Number(event.gateScore) || 0,
      JSON.stringify(asArray(event.gateReasons)),
      0,
      JSON.stringify(event.meta || {}),
    )
    this.bump()
    return Number(result.lastInsertRowid)
  }

  getEvent(id) {
    const row = this.stmt.getEvent.get(id)
    return row ? eventFromRow(row) : undefined
  }

  listEvents(filter = {}) {
    const where = []
    const params = []
    if (filter.platform) {
      where.push('platform = ?')
      params.push(filter.platform)
    }
    if (filter.scopeId) {
      where.push('scope_id = ?')
      params.push(filter.scopeId)
    }
    if (filter.consolidated === true) where.push('consolidated = 1')
    if (filter.consolidated === false) where.push('consolidated = 0')
    if (filter.admitted === true) where.push('admitted = 1')
    if (filter.admitted === false) where.push('admitted = 0')
    if (filter.sinceId) {
      where.push('id > ?')
      params.push(Number(filter.sinceId))
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const direction = filter.order === 'asc' ? 'ASC' : 'DESC'
    const limit = Math.min(Number(filter.limit) || 50, 500)
    const rows = this.db
      .prepare(`SELECT * FROM memory_events ${clause} ORDER BY id ${direction} LIMIT ?`)
      .all(...params, limit)
    return rows.map(eventFromRow)
  }

  countEvents(filter = {}) {
    return this.listEvents({ ...filter, limit: 500 }).length
  }

  markEventsConsolidated(ids) {
    for (const id of ids) this.stmt.markConsolidated.run(id)
    this.bump()
  }

  getMeta(key, fallback = null) {
    const row = this.stmt.getMeta.get(key)
    return row ? jsonParse(row.value, row.value) : fallback
  }

  setMeta(key, value) {
    this.stmt.setMeta.run(key, JSON.stringify(value))
  }

  transaction(fn) {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }
}

/** -------------------------------- JSON -------------------------------- */

class JsonStore {
  constructor(file) {
    this.backend = 'json'
    this.file = file
    this.revision = 0
    this.lastError = null
    this.fts = false
    this.vectorIndex = 'blob-cosine'
    this.data = {
      version: 1,
      notes: {},
      embeddings: {},
      profiles: {},
      facts: [],
      events: [],
      meta: {},
      nextEventId: 1,
    }
    this.load()
  }

  load() {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data = { ...this.data, ...parsed }
    } catch (error) {
      this.lastError = String(error?.message || error)
    }
  }

  persist() {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data))
    renameSync(tmp, this.file)
  }

  bump() {
    this.revision += 1
    this.persist()
  }

  putNote(note) {
    this.data.notes[note.id] = { ...note, archived: Boolean(note.archived) }
    this.bump()
    return note
  }

  getNote(id) {
    const note = this.data.notes[id]
    return note ? structuredClone(note) : undefined
  }

  deleteNote(id) {
    delete this.data.notes[id]
    delete this.data.embeddings[id]
    this.bump()
    return true
  }

  listNotes(filter = {}) {
    const notes = Object.values(this.data.notes)
      .filter((note) => noteMatches(note, filter))
      .sort((a, b) => (filter.orderBy === 'importance' ? b.importance - a.importance : String(b.createdAt).localeCompare(String(a.createdAt))))
    const offset = Math.max(Number(filter.offset) || 0, 0)
    const limit = Math.min(Number(filter.limit) || 50, 500)
    return notes.slice(offset, offset + limit).map((note) => structuredClone(note))
  }

  allNotes(limit = 2000) {
    return Object.values(this.data.notes)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, Math.min(Number(limit) || 2000, 20000))
      .map((note) => structuredClone(note))
  }

  searchNotes(query, filter = {}) {
    const text = String(query || '').trim().toLowerCase()
    if (!text) return this.listNotes(filter)
    return Object.values(this.data.notes)
      .filter((note) => {
        if (!noteMatches(note, filter)) return false
        const haystack = [note.content, note.contextSummary, ...(note.keywords || []), ...(note.tags || [])].join(' ').toLowerCase()
        return haystack.includes(text)
      })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, Math.min(Number(filter.limit) || 30, 200))
      .map((note) => structuredClone(note))
  }

  countNotes(filter = {}) {
    return Object.values(this.data.notes).filter((note) => noteMatches(note, filter)).length
  }

  stats() {
    const notes = Object.values(this.data.notes)
    return {
      notes: notes.length,
      archived: notes.filter((note) => note.archived).length,
      events: this.data.events.length,
      pendingEvents: this.data.events.filter((event) => !event.consolidated && event.admitted).length,
      profiles: Object.keys(this.data.profiles).length,
      vectors: Object.keys(this.data.embeddings).length,
    }
  }

  putEmbedding(id, vec) {
    this.data.embeddings[id] = Buffer.from(encodeVector(vec)).toString('base64')
    this.bump()
  }

  getEmbedding(id) {
    const encoded = this.data.embeddings[id]
    return encoded ? decodeVector(Buffer.from(encoded, 'base64')) : null
  }

  allEmbeddings() {
    const map = new Map()
    for (const [id, encoded] of Object.entries(this.data.embeddings)) {
      const vec = decodeVector(Buffer.from(encoded, 'base64'))
      if (vec) map.set(id, vec)
    }
    return map
  }

  upsertProfile(profile) {
    const key = `${profile.platform}:${profile.userId}`
    const previous = this.data.profiles[key]
    const at = iso(profile.updatedAt)
    const nextFacts = profile.activeFacts || {}
    for (const [factKey, value] of Object.entries(nextFacts)) {
      if (String((previous?.activeFacts || {})[factKey]) === String(value)) continue
      for (const fact of this.data.facts) {
        if (fact.platform === profile.platform && fact.userId === profile.userId && fact.key === factKey && !fact.invalidAt) {
          fact.invalidAt = at
        }
      }
      this.data.facts.push({
        platform: profile.platform,
        userId: profile.userId,
        key: factKey,
        value: String(value),
        validFrom: at,
        invalidAt: null,
        updatedAt: at,
      })
    }
    this.data.profiles[key] = { ...profile, activeFacts: nextFacts, updatedAt: at }
    this.bump()
    return profile
  }

  getProfile(platform, userId) {
    const profile = this.data.profiles[`${platform}:${userId}`]
    return profile ? structuredClone(profile) : undefined
  }

  listProfiles() {
    return Object.values(this.data.profiles)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((profile) => structuredClone(profile))
  }

  replaceFacts(platform, userId, facts, at = nowIso()) {
    const current = this.getProfile(platform, userId)?.activeFacts || {}
    for (const [key, value] of Object.entries(facts)) {
      if (current[key] === value) continue
      for (const fact of this.data.facts) {
        if (fact.platform === platform && fact.userId === userId && fact.key === key && !fact.invalidAt) {
          fact.invalidAt = at
        }
      }
      this.data.facts.push({ platform, userId, key, value: String(value), validFrom: at, invalidAt: null, updatedAt: at })
    }
  }

  listFactHistory(platform, userId) {
    return this.data.facts.filter((fact) => fact.platform === platform && fact.userId === userId)
  }

  appendEvent(event) {
    const id = this.data.nextEventId
    this.data.nextEventId += 1
    this.data.events.push({
      id,
      botId: event.botId || 'dafeiyu',
      platform: event.platform,
      scopeId: event.scopeId,
      userId: event.userId || null,
      nickname: event.nickname || null,
      content: event.content,
      createdAt: iso(event.createdAt),
      admitted: event.admitted !== false,
      gateScore: Number(event.gateScore) || 0,
      gateReasons: asArray(event.gateReasons),
      consolidated: false,
      meta: event.meta || {},
    })
    this.bump()
    return id
  }

  getEvent(id) {
    const event = this.data.events.find((entry) => entry.id === Number(id))
    return event ? structuredClone(event) : undefined
  }

  listEvents(filter = {}) {
    const events = this.data.events
      .filter((event) => eventMatches(event, filter))
      .sort((a, b) => (filter.order === 'asc' ? a.id - b.id : b.id - a.id))
      .slice(0, Math.min(Number(filter.limit) || 50, 500))
    return events.map((event) => structuredClone(event))
  }

  countEvents(filter = {}) {
    return this.data.events.filter((event) => eventMatches(event, filter)).length
  }

  markEventsConsolidated(ids) {
    const wanted = new Set(ids.map(Number))
    for (const event of this.data.events) if (wanted.has(event.id)) event.consolidated = true
    this.bump()
  }

  getMeta(key, fallback = null) {
    return Object.hasOwn(this.data.meta, key) ? this.data.meta[key] : fallback
  }

  setMeta(key, value) {
    this.data.meta[key] = value
    this.persist()
  }

  transaction(fn) {
    const result = fn()
    this.persist()
    return result
  }

  close() {
    this.persist()
  }
}

/** ----------------------------- Factory ------------------------------- */

export async function openStore({ file, forceJson = false } = {}) {
  if (!file) throw new Error('openStore requires a file path')
  mkdirSync(dirname(file), { recursive: true })
  const explicitJson = forceJson || process.env.DSH_BIOMIMETIC_STORE === 'json'
  if (!explicitJson) {
    try {
      const module = await import('node:sqlite')
      if (typeof module.DatabaseSync === 'function') {
        return new SqliteStore(module.DatabaseSync, file)
      }
    } catch {
      /* fall through to the JSON backend */
    }
  }
  return new JsonStore(file)
}

export { SqliteStore, JsonStore, noteMatches, eventMatches }
export const NOTE_ID = () => randomUUID()
