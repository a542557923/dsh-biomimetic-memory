/**
 * Standalone memory bridge for external bot frameworks (AstrBot / NoneBot etc.).
 *
 * It loads the same engine and the same single SQLite file as the Harness
 * plugin, then exposes the panel's action API on a fixed loopback port so a
 * 24/7 QQ bot does not depend on the Harness Web port (which is chosen at
 * boot and changes between launches).
 *
 *   node lib/bridge.mjs
 *   POST http://127.0.0.1:8787/  {"action":"recall", ...}
 *   header: x-biomimetic-memory: 1
 */

import http from 'node:http'
import { createEngine } from './engine.js'
import { dispatch } from './http.js'

const PORT = Number(process.env.DSH_BIOMIMETIC_BRIDGE_PORT || 8787)
const HOST = process.env.DSH_BIOMIMETIC_BRIDGE_HOST || '127.0.0.1'
const MAX_BODY = 1_000_000

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
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
        reject(new Error(`invalid JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

const engine = createEngine({
  autoConsolidate: false,
  ...(process.env.DSH_BIOMIMETIC_MEMORY_DB ? { dataFile: process.env.DSH_BIOMIMETIC_MEMORY_DB } : {}),
})

await engine.ensureReady()

const server = http.createServer(async (req, res) => {
  if (String(req.headers['x-biomimetic-memory'] || '') !== '1') {
    send(res, 403, { error: 'missing x-biomimetic-memory request marker' })
    return
  }
  const url = new URL(req.url || '/', 'http://localhost')
  const query = Object.fromEntries(url.searchParams.entries())
  try {
    let body = {}
    if (req.method === 'POST') body = await readBody(req)
    const action =
      body.action ||
      query.action ||
      url.pathname.replace(/^\/+|\/+$/g, '') ||
      'health'
    const result = await dispatch(engine, action, body, query)
    send(res, 200, result)
  } catch (error) {
    send(res, Number(error?.statusCode) || 400, { error: String(error?.message || error) })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`MEMORY_BRIDGE_READY http://${HOST}:${PORT}/`)
})

let closing = false
async function shutdown(signal) {
  if (closing) return
  closing = true
  console.log(`MEMORY_BRIDGE_STOP ${signal}`)
  server.close()
  try {
    await engine.close()
  } catch {
    /* already closed */
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
