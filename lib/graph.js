/**
 * Hippocampus multi-hop association graph.
 *
 * Cards contribute nodes for the users they involve, the entities they
 * mention, and the cards themselves.  A lightweight Personalized PageRank
 * over that undirected graph answers "given who is talking and what words are
 * on screen, which distant memory is one or two hops away?" — the HippoRAG
 * pattern, implemented in-process with no graph database.
 */

import { normalize } from './greenlight.js'

function nodeKey(kind, value) {
  return `${kind}:${normalize(value)}`
}

export class HippocampusGraph {
  constructor(notes = []) {
    this.adjacency = new Map()
    this.noteNodes = new Map()
    this.entityLabels = new Map()
    this.nodeCount = 0
    this.edgeCount = 0
    this.revision = -1
    this.build(notes)
  }

  link(a, b, weight = 1) {
    if (!a || !b || a === b) return
    if (!this.adjacency.has(a)) {
      this.adjacency.set(a, new Map())
      this.nodeCount += 1
    }
    if (!this.adjacency.has(b)) {
      this.adjacency.set(b, new Map())
      this.nodeCount += 1
    }
    const left = this.adjacency.get(a)
    const right = this.adjacency.get(b)
    if (!left.has(b)) this.edgeCount += 1
    left.set(b, (left.get(b) || 0) + weight)
    right.set(a, (right.get(a) || 0) + weight)
  }

  build(notes) {
    this.adjacency.clear()
    this.noteNodes.clear()
    this.entityLabels.clear()
    this.nodeCount = 0
    this.edgeCount = 0
    for (const note of notes) {
      const noteNode = nodeKey('note', note.id)
      this.noteNodes.set(note.id, noteNode)
      this.adjacency.set(noteNode, this.adjacency.get(noteNode) || new Map())
      this.nodeCount += 1
      for (const userId of note.relatedUserIds || []) {
        const userNode = nodeKey('user', userId)
        this.entityLabels.set(userNode, String(userId))
        this.link(noteNode, userNode, 1)
      }
      for (const entity of note.entities || []) {
        const text = String(entity)
        const kind = /^user[_:]/i.test(text) ? 'user' : 'entity'
        const value = kind === 'user' ? text.replace(/^user[_:]/i, '') : text
        const entityNode = nodeKey(kind, value)
        this.entityLabels.set(entityNode, value)
        this.link(noteNode, entityNode, 1)
      }
      for (const linked of note.linkedNoteIds || []) {
        this.link(noteNode, nodeKey('note', linked), 0.8)
      }
    }
  }

  isStale(revision) {
    return revision !== this.revision
  }

  /** Build a fresh graph for a store revision. */
  static forNotes(notes, revision) {
    const graph = new HippocampusGraph(notes)
    graph.revision = revision
    return graph
  }

  /** Find entity/user nodes whose label occurs literally in the text. */
  seedsFromText(text, { platform, userId, extraUsers = [] } = {}) {
    const seeds = new Map()
    const haystack = normalize(text)
    for (const [node, label] of this.entityLabels) {
      const needle = normalize(label)
      if (needle.length < 2) continue
      if (haystack.includes(needle)) {
        seeds.set(node, (seeds.get(node) || 0) + 1)
      }
    }
    if (userId) {
      const userNode = nodeKey('user', userId)
      seeds.set(userNode, (seeds.get(userNode) || 0) + 2)
    }
    for (const extra of extraUsers) {
      const userNode = nodeKey('user', extra)
      seeds.set(userNode, (seeds.get(userNode) || 0) + 1)
    }
    // A platform-wide super-node keeps cross-scope acquaintances reachable.
    if (platform) this._platform = platform
    return seeds
  }

  /**
   * Personalized PageRank with power iteration.
   * @returns Map<noteId, normalized 0..1 score>
   */
  ppr(seeds, { alpha = 0.85, iterations = 20 } = {}) {
    const scores = new Map()
    if (!seeds || seeds.size === 0) return scores
    const nodes = [...this.adjacency.keys()]
    const teleport = new Map()
    let total = 0
    for (const [node, weight] of seeds) {
      if (!this.adjacency.has(node)) continue
      teleport.set(node, weight)
      total += weight
    }
    if (total === 0) return scores
    for (const [node, weight] of teleport) teleport.set(node, weight / total)

    let rank = new Map()
    for (const node of nodes) rank.set(node, 0)
    for (const [node, weight] of teleport) rank.set(node, weight)

    for (let step = 0; step < iterations; step += 1) {
      const next = new Map()
      for (const node of nodes) next.set(node, 0)
      let dangling = 0
      for (const node of nodes) {
        const weight = rank.get(node) || 0
        if (weight === 0) continue
        const neighbors = this.adjacency.get(node)
        if (!neighbors || neighbors.size === 0) {
          dangling += weight
          continue
        }
        let degree = 0
        for (const value of neighbors.values()) degree += value
        if (degree === 0) {
          dangling += weight
          continue
        }
        for (const [neighbor, edge] of neighbors) {
          next.set(neighbor, next.get(neighbor) + (alpha * weight * edge) / degree)
        }
      }
      for (const [node, weight] of teleport) {
        next.set(node, next.get(node) + (1 - alpha) * weight + alpha * dangling * weight)
      }
      rank = next
    }

    let max = 0
    for (const [id, node] of this.noteNodes) {
      const value = rank.get(node) || 0
      scores.set(id, value)
      if (value > max) max = value
    }
    if (max > 0) for (const [id, value] of scores) scores.set(id, value / max)
    return scores
  }

  stats() {
    return { nodes: this.nodeCount, edges: this.edgeCount, notes: this.noteNodes.size }
  }
}

/**
 * Build or reuse a graph from the store.  The graph is rebuilt only when the
 * store revision changed, so recall stays cheap during a burst of messages.
 */
export function ensureGraph(cache, store, notes) {
  if (!cache.graph || cache.graph.isStale(store.revision)) {
    cache.graph = HippocampusGraph.forNotes(notes, store.revision)
  }
  return cache.graph
}

export { nodeKey }
