/**
 * Local API for the Web panel.
 *
 * Two adapters over one dispatcher:
 *  - the authenticated `/api/biomimetic-memory` fetch route (used when the
 *    Connection service is mounted, so the owner page calls it with its own
 *    credentials);
 *  - a `/biomimetic-memory/` prefix on the bare web server as a fallback.
 *
 * Mutating calls always require the JSON content type and a custom
 * `x-biomimetic-memory` marker; on the bare route that stops a third-party
 * page from driving them with a simple form post.
 */

export const FETCH_PATH = '/api/biomimetic-memory'
// The web server matches a prefix only at a path boundary (`/x` matches
// `/x/y` but not `/x//y`), so the prefix itself carries no trailing slash.
export const ROUTE_PATH = '/biomimetic-memory'
const MAX_BODY = 1_000_000

function jsonResponse(status, payload) {
  const body = JSON.stringify(payload)
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    },
    body,
  }
}

function sendNodeJson(res, status, payload) {
  const { headers, body } = jsonResponse(status, payload)
  res.writeHead(status, headers)
  res.end(body)
}

function readNodeBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

function scopesOf(notes) {
  const map = new Map()
  for (const note of notes) {
    const key = `${note.platform}:${note.scopeId}`
    const entry = map.get(key) || { platform: note.platform, scopeId: note.scopeId, count: 0, archived: 0 }
    entry.count += 1
    if (note.archived) entry.archived += 1
    map.set(key, entry)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

/** Single implementation behind both transports and the agent tools. */
export async function dispatch(engine, action, payload = {}, query = {}) {
  const pick = (key) => payload[key] ?? query[key]
  switch (action) {
    case 'state': {
      const source = { ...payload, ...query }
      const platform = source.platform || undefined
      const scopeId = source.scope || source.scope_id || undefined
      const text = source.q || source.query || ''
      const limit = Math.min(Number(source.limit) || 200, 500)
      const stats = await engine.stats()
      const notesResult = await engine.notes({
        action: text ? 'search' : 'list',
        query: text,
        platform,
        scopeId,
        limit,
        offset: 0,
      })
      const profiles = await engine.profiles({ action: 'list', limit: 200 })
      return {
        stats,
        notes: notesResult.notes || [],
        scopes: scopesOf(notesResult.notes || []),
        profiles: profiles.profiles || [],
        filter: { platform: platform || null, scopeId: scopeId || null, query: text || null },
      }
    }
    case 'health':
      return engine.health()
    case 'recall':
      return engine.debugRecall({
        platform: payload.platform || 'global',
        scopeId: payload.scope_id || payload.scopeId || 'global',
        userId: payload.user_id || payload.userId,
        query: payload.query || '',
        limit: payload.limit || 5,
        includeRecent: payload.includeRecent !== false,
      })
    case 'consolidate':
      return engine.consolidate({
        mode: payload.mode || 'auto',
        platform: payload.platform || 'global',
        scopeId: payload.scope_id || payload.scopeId || 'global',
        limit: payload.limit,
        maxCards: payload.max_cards || payload.maxCards,
        payload: payload.payload,
      })
    case 'notes':
      return engine.notes({
        action: payload.action || 'list',
        id: payload.id,
        query: payload.query,
        platform: payload.platform,
        scopeId: payload.scope_id || payload.scopeId,
        archived: typeof payload.archived === 'boolean' ? payload.archived : undefined,
        limit: payload.limit,
        offset: payload.offset,
      })
    case 'profile':
      return engine.profiles({
        action: payload.subaction || payload.profileAction || 'list',
        platform: payload.platform || 'global',
        userId: payload.user_id || payload.userId,
        nickname: payload.nickname,
        alias: payload.alias,
        stage: payload.stage,
        affectionDelta: payload.affection_delta ?? payload.affectionDelta,
        facts: payload.facts,
        limit: payload.limit,
      })
    case 'ingest':
      return engine.ingest({
        platform: payload.platform || 'global',
        scopeId: payload.scope_id || payload.scopeId || 'global',
        userId: payload.user_id || payload.userId,
        nickname: payload.nickname,
        content: payload.content,
      })
    default:
      throw Object.assign(new Error(`unknown action ${String(pick('action') ?? action)}`), { statusCode: 404 })
  }
}

function normaliseAction(value) {
  return String(value || 'state').replace(/^\/+|\/+$/g, '') || 'state'
}

/** Bare-web-server adapter (also used when no Connection service exists). */
export function createMemoryRoute(engine) {
  return async function handle(req, res) {
    if (String(req.headers['x-biomimetic-memory'] || '') !== '1') {
      sendNodeJson(res, 403, { error: 'missing x-biomimetic-memory request marker' })
      return
    }
    const url = new URL(req.url || ROUTE_PATH, 'http://localhost')
    const rest = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : url.pathname
    const segment = rest.replace(/^\/+|\/+$/g, '')
    const query = Object.fromEntries(url.searchParams.entries())
    try {
      let body = {}
      if (req.method === 'POST') body = await readNodeBody(req)
      const action = normaliseAction(segment || body.action || query.action)
      const result = await dispatch(engine, action, body, query)
      sendNodeJson(res, 200, result)
    } catch (error) {
      sendNodeJson(res, Number(error?.statusCode) || 400, { error: String(error?.message || error) })
    }
  }
}

/** Authenticated `/api/biomimetic-memory` route owned by the Connection service. */
export function createMemoryFetch(engine) {
  return async function handleFetch(request) {
    try {
      const url = new URL(request.url, 'http://localhost')
      const query = Object.fromEntries(url.searchParams.entries())
      let body = {}
      if (request.method === 'POST') {
        try {
          body = await request.json()
        } catch {
          body = {}
        }
      }
      const action = normaliseAction(body.action || query.action)
      const result = await dispatch(engine, action, body, query)
      return Response.json(result, { status: 200, headers: { 'cache-control': 'no-store' } })
    } catch (error) {
      return Response.json(
        { error: String(error?.message || error) },
        { status: Number(error?.statusCode) || 400, headers: { 'cache-control': 'no-store' } },
      )
    }
  }
}
