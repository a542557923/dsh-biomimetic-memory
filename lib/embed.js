/**
 * Local, dependency-free text embeddings.
 *
 * The specification asks for a 512-dimension vector column.  We keep that
 * shape, but compute the vector locally with a signed hashing trick over
 * character bigrams (strong for Chinese) and latin words.  This means the
 * engine never needs an embedding API key and never leaves the machine,
 * while still giving recall a semantic fallback when no green-light keyword
 * matches literally.
 */

export const EMBED_DIM = 512

const LATIN = /[a-z0-9_]+/g
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/** FNV-1a 32-bit, stable across runs and platforms. */
function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function hashToken(token, weight, vec) {
  const hash = fnv1a(token)
  const index = hash % EMBED_DIM
  const sign = (hash & 0x80000000) === 0 ? 1 : -1
  vec[index] += sign * weight
  // A second independent slot reduces collisions for short CJK tokens.
  const second = fnv1a(`#${token}`) % EMBED_DIM
  vec[second] += ((hash >>> 7) & 1 ? -1 : 1) * weight * 0.5
}

/** Token weights used by the embedder and the keyword extractor. */
export function tokenize(text) {
  const tokens = []
  if (typeof text !== 'string' || text.length === 0) return tokens
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(LATIN)) {
    const word = match[0]
    if (word.length < 2) continue
    tokens.push({ token: word, weight: 1.2, kind: 'latin' })
  }

  for (const match of lower.matchAll(CJK)) {
    const run = match[0]
    for (let i = 0; i < run.length; i += 1) {
      tokens.push({ token: run[i], weight: 0.35, kind: 'cjk-char' })
      if (i + 1 < run.length) {
        tokens.push({ token: run.slice(i, i + 2), weight: 1, kind: 'cjk-bigram' })
      }
      if (i + 2 < run.length) {
        tokens.push({ token: run.slice(i, i + 3), weight: 0.55, kind: 'cjk-trigram' })
      }
    }
  }

  return tokens
}

/** Embed one string into a unit-length Float32Array of length EMBED_DIM. */
export function embed(text) {
  const vec = new Float32Array(EMBED_DIM)
  for (const { token, weight } of tokenize(text)) hashToken(token, weight, vec)
  let norm = 0
  for (let i = 0; i < EMBED_DIM; i += 1) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < EMBED_DIM; i += 1) vec[i] /= norm
  }
  return vec
}

/** Cosine similarity of two unit vectors, clamped into [0, 1]. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  const value = dot / Math.sqrt(na * nb)
  return Math.min(1, Math.max(0, (value + 1) / 2))
}

/** Serialize a vector for a SQLite BLOB column. */
export function encodeVector(vec) {
  const buffer = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i += 1) buffer.writeFloatLE(vec[i], i * 4)
  return buffer
}

/** Deserialize a vector previously produced by encodeVector. */
export function decodeVector(blob, dim = EMBED_DIM) {
  if (!blob) return null
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buffer.byteLength < dim * 4) return null
  const vec = new Float32Array(dim)
  for (let i = 0; i < dim; i += 1) vec[i] = buffer.readFloatLE(i * 4)
  return vec
}
