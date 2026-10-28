/**
 * End-to-end engine tests (no Harness needed).
 * Run with: node test/engine.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { openStore } from '../lib/store.js'
import { embed, cosine } from '../lib/embed.js'
import { extractKeywords, scoreMessage, scanNote } from '../lib/greenlight.js'
import { createEngine } from '../lib/engine.js'
import { runMaintenance, autoConsolidate } from '../lib/consolidator.js'
import { recall } from '../lib/retriever.js'
import { formatCoreMemories } from '../lib/prompt.js'
import { ebbinghausRetention } from '../lib/scoring.js'

const dir = mkdtempSync(join(process.cwd(), '.tmp-test-'))
let passed = 0

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok ${passed} - ${name}`)
    })
    .catch((error) => {
      console.error(`not ok - ${name}`)
      throw error
    })
}

const GROUP = { platform: 'qq', scopeId: 'group_10086' }

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

try {
  await test('embedding is deterministic and normalised', () => {
    const a = embed('倒立洗头 抽卡歪了七七')
    const b = embed('倒立洗头 抽卡歪了七七')
    assert.equal(cosine(a, b), 1)
    assert.ok(cosine(a, embed('今天天气不错')) < 0.25, 'unrelated raw cosine must stay near zero')
    assert.ok(cosine(embed('阿伟倒立洗头'), embed('阿伟立下倒立洗头的 flag，全群围观。')) > 0.4)
  })

  await test('green-light extraction ignores filler and keeps the coined phrase', () => {
    const keywords = extractKeywords('兄弟们我立个flag，说不出金就倒立洗头，赌一包辣条')
    assert.ok(keywords.includes('倒立洗头'), `keywords=${keywords.join(',')}`)
    assert.ok(!keywords.includes('今天'))
    const named = extractKeywords('@过客家的大肥鱼 评价一下林北')
    assert.ok(named.includes('林北'), `keywords=${named.join(',')}`)
    assert.ok(!named.includes('评价一'), `keywords=${named.join(',')}`)
  })

  await test('noise gate drops emoji/echo spam and keeps mentions', () => {
    assert.equal(scoreMessage({ content: '哈哈哈' }).admit, false)
    assert.equal(scoreMessage({ content: '？？？' }).admit, false)
    assert.equal(scoreMessage({ content: '@大肥鱼 你作证，我这次真不出金就倒立洗头' }).admit, true)
  })

  await test('SQLite store persists notes, vectors, events and profiles', async () => {
    const file = join(dir, 'sqlite', 'memory.sqlite')
    const store = await openStore({ file })
    assert.equal(store.backend, 'sqlite')
    const note = {
      id: 'note-sqlite-1',
      botId: 'dafeiyu',
      platform: 'qq',
      scopeId: GROUP.scopeId,
      relatedUserIds: ['12345678'],
      content: '阿伟立下倒立洗头的flag',
      contextSummary: 'flag 名场面',
      keywords: ['倒立洗头', 'flag'],
      secondaryKeys: [],
      tags: ['名场面'],
      strategy: 'selective',
      importance: 8,
      strength: 1,
      accessCount: 0,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      linkedNoteIds: [],
      entities: ['user_12345678', '倒立洗头'],
      archived: false,
    }
    store.putNote(note)
    store.putEmbedding(note.id, embed(note.content))
    assert.equal(store.getNote(note.id).content, note.content)
    const searched = store.searchNotes('倒立洗头')
    assert.ok(searched.some((entry) => entry.id === note.id))
    assert.ok(store.allEmbeddings().has(note.id))
    store.upsertProfile({
      platform: 'qq',
      userId: '12345678',
      nickname: '阿伟',
      botNicknameForUser: '倒立洗头哥',
      affectionScore: 60,
      relationshipStage: '损友',
      activeFacts: { 游戏运势: '非酋' },
      updatedAt: new Date().toISOString(),
    })
    assert.equal(store.getProfile('qq', '12345678').botNicknameForUser, '倒立洗头哥')
    store.replaceFacts('qq', '12345678', { 游戏运势: '脱非入欧' })
    assert.ok(store.listFactHistory('qq', '12345678').some((fact) => fact.invalidAt))
    const eventId = store.appendEvent({
      platform: 'qq',
      scopeId: GROUP.scopeId,
      userId: '12345678',
      nickname: '阿伟',
      content: '测试事件',
      admitted: true,
      gateScore: 5,
      gateReasons: [],
    })
    assert.equal(store.getEvent(eventId).content, '测试事件')
    assert.equal(store.stats().notes, 1)
    store.close()
  })

  await test('JSON fallback keeps the same surface', async () => {
    const file = join(dir, 'json', 'memory.json')
    const store = await openStore({ file, forceJson: true })
    assert.equal(store.backend, 'json')
    store.putNote({
      id: 'note-json-1',
      botId: 'dafeiyu',
      platform: 'bilibili',
      scopeId: 'video_42',
      relatedUserIds: ['9988'],
      content: 'B站热评：大肥鱼是赛博鱼塘塘主',
      contextSummary: '热评梗',
      keywords: ['赛博鱼塘'],
      secondaryKeys: [],
      tags: ['B站热评梗'],
      strategy: 'selective',
      importance: 6,
      strength: 1,
      accessCount: 0,
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString(),
      linkedNoteIds: [],
      entities: ['赛博鱼塘'],
      archived: false,
    })
    assert.equal(store.searchNotes('赛博鱼塘').length, 1)
    store.close()
    const reopened = await openStore({ file, forceJson: true })
    assert.equal(reopened.getNote('note-json-1').platform, 'bilibili')
    reopened.close()
  })

  await test('ingest -> auto consolidate -> recall with score breakdown', async () => {
    const engine = createEngine({ dataFile: join(dir, 'engine', 'memory.sqlite'), autoConsolidate: false })
    const messages = [
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '12345678', nickname: '阿伟', content: '兄弟们我立个flag，说不出金就倒立洗头，赌一包辣条' },
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '22334455', nickname: '小美', content: '阿伟你上次抽卡就歪了七七，这次肯定又歪' },
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '12345678', nickname: '阿伟', content: '别说了，资深非酋本人，已经准备好倒立了' },
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '99990000', nickname: '路人', content: '哈哈哈' },
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '12345678', nickname: '阿伟', content: '@大肥鱼 你作证，我这次真不出金就倒立洗头' },
      { platform: 'qq', scopeId: GROUP.scopeId, userId: '22334455', nickname: '小美', content: '我作证！截图了' },
    ]
    for (const message of messages) {
      await engine.ingest(message)
    }
    const pending = await engine.pending('qq', GROUP.scopeId)
    assert.equal(pending.events.length, 5, 'noise message must not enter the consolidation pool')

    const consolidated = await engine.consolidate({ platform: 'qq', scopeId: GROUP.scopeId, mode: 'auto', maxCards: 2 })
    assert.ok(consolidated.created.length >= 1, 'expected at least one card')
    assert.ok(consolidated.created[0].keywords.length >= 2)

    const recalled = await engine.recallFor({
      platform: 'qq',
      scopeId: GROUP.scopeId,
      userId: '12345678',
      query: '阿伟你还记得倒立洗头那事吗',
      limit: 3,
    })
    assert.ok(recalled.items.length >= 1)
    const top = recalled.items[0]
    assert.ok(top.score.final_score > 0)
    assert.ok(top.score.greenlight_score > 0)
    assert.ok(top.score.user_match_score > 0)
    assert.ok(top.strength > 1, 'recall must reinforce the card')

    const profiles = await engine.profiles({ action: 'list', platform: 'qq' })
    assert.ok(profiles.profiles.some((profile) => profile.userId === '12345678'))
    const aw = profiles.profiles.find((profile) => profile.userId === '12345678')
    assert.ok(aw.affectionScore > 50)

    const stats = await engine.stats()
    assert.ok(stats.notes >= 1)
    assert.ok(stats.events >= 6)
    await engine.close()
  })

  await test('Ebbinghaus decay archives low-value cards and green-light force-wakes them', async () => {
    const engine = createEngine({ dataFile: join(dir, 'decay', 'memory.sqlite'), autoConsolidate: false })
    await engine.ingest({ platform: 'qq', scopeId: 'group_7', userId: '1', nickname: '甲', content: '我们说好下周去吃火锅，甲请客' })
    await engine.consolidate({ platform: 'qq', scopeId: 'group_7', mode: 'auto' })
    const store = await engine.ensureReady()
    const notes = store.allNotes()
    assert.ok(notes.length >= 1)
    const card = notes[0]
    card.importance = 2
    card.strength = 1
    card.lastAccessedAt = isoDaysAgo(45)
    store.putNote(card)
    assert.ok(ebbinghausRetention(card) < 0.15)
    const maintenance = runMaintenance(store)
    assert.ok(maintenance.archived.some((entry) => entry.id === card.id))
    assert.equal(store.getNote(card.id).archived, true)

    const keys = store.getNote(card.id).keywords
    assert.ok(keys.length >= 1)
    const recalled = recall(store, { graph: null }, {
      platform: 'qq',
      scopeId: 'group_7',
      query: `还记得${keys[0]}吗`,
      limit: 3,
      reinforce: false,
    })
    assert.ok(recalled.items.some((item) => item.id === card.id && item.forcedByKeyword), 'archived card must wake on its literal wake word')
    await engine.close()
  })

  await test('consolidation payload promotes core memories and records profile history', async () => {
    const engine = createEngine({ dataFile: join(dir, 'core', 'memory.sqlite'), autoConsolidate: false })
    const payload = {
      new_memories: [
        {
          content: '小美在凌晨三点陪我看完了整场抽卡直播，还替我骂了策划，我决定把她当死党。',
          context_summary: '凌晨三点抽卡名场面',
          related_user_ids: ['22334455'],
          keywords: ['凌晨三点', '抽卡直播', '死党', '骂策划'],
          tags: ['情感互动', '名场面'],
          entities: ['user_22334455', '抽卡直播'],
          importance: 9.5,
        },
      ],
      profile_updates: [
        {
          user_id: '22334455',
          nickname: '小美',
          bot_nickname_for_user: '深夜战友',
          affection_delta: 5,
          relationship_stage: '死忠粉',
          facts_to_upsert: { 作息: '凌晨活跃', 关系: '和我是深夜战友' },
        },
      ],
    }
    const result = await engine.consolidate({ platform: 'qq', scopeId: 'group_9', mode: 'apply', payload })
    assert.equal(result.created.length, 1)
    assert.ok(result.maintenance.promoted.length >= 1)

    const noteList = await engine.notes({ action: 'list', platform: 'qq' })
    const core = noteList.notes.find((note) => note.strategy === 'constant')
    assert.ok(core, 'top card must be promoted to Tier 0')

    const profile = await engine.profiles({ action: 'get', platform: 'qq', userId: '22334455' })
    assert.equal(profile.profile.botNicknameForUser, '深夜战友')
    assert.equal(profile.profile.relationshipStage, '死忠粉')
    assert.ok(profile.profile.affectionScore > 50)
    await engine.close()
  })

  await test('A-MEM links are built both ways from shared wake words', async () => {
    const engine = createEngine({ dataFile: join(dir, 'links', 'memory.sqlite'), autoConsolidate: false })
    const first = await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_1',
      mode: 'apply',
      payload: { new_memories: [{ content: '阿伟倒立洗头翻车了', keywords: ['倒立洗头', '翻车'], importance: 8 }] },
    })
    const second = await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_1',
      mode: 'apply',
      payload: { new_memories: [{ content: '群里把倒立洗头做成了表情包', keywords: ['倒立洗头', '表情包'], importance: 7 }] },
    })
    const store = await engine.ensureReady()
    const a = store.getNote(first.created[0].id)
    const b = store.getNote(second.created[0].id)
    assert.ok(a.linkedNoteIds.includes(b.id))
    assert.ok(b.linkedNoteIds.includes(a.id))
    await engine.close()
  })

  await test('scope isolation: strict mode only wakes cards of the current group', async () => {
    const engine = createEngine({ dataFile: join(dir, 'scopes', 'memory.sqlite'), autoConsolidate: false })
    await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_A',
      mode: 'apply',
      payload: { new_memories: [{ content: 'A群约定周末开黑', keywords: ['开黑', '周末'], importance: 6 }] },
    })
    await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_B',
      mode: 'apply',
      payload: { new_memories: [{ content: 'B群讨论周末开黑阵容', keywords: ['开黑', '阵容'], importance: 6 }] },
    })
    const strict = await engine.recallFor({
      platform: 'qq',
      scopeId: 'group_A',
      scopeMode: 'strict',
      query: '周末开黑吗',
      limit: 5,
      reinforce: false,
    })
    assert.ok(strict.items.length >= 1)
    assert.ok(strict.items.every((item) => item.scopeId === 'group_A'))
    const wide = await engine.recallFor({
      platform: 'qq',
      scopeId: 'group_A',
      scopeMode: 'cross_platform',
      query: '周末开黑吗',
      limit: 5,
      reinforce: false,
    })
    assert.ok(wide.items.some((item) => item.scopeId === 'group_B'))
    await engine.close()
  })

  await test('batch threshold suggests consolidation after 40 admitted messages', async () => {
    const engine = createEngine({ dataFile: join(dir, 'batch', 'memory.sqlite'), autoConsolidate: false })
    let last
    for (let index = 0; index < 41; index += 1) {
      last = await engine.ingest({
        platform: 'qq',
        scopeId: 'group_77',
        userId: '1',
        nickname: '话痨',
        content: `第${index}条：@大肥鱼 今天群里的梗是${index}号翻车现场，大家都笑疯了`,
      })
    }
    assert.equal(last.suggestConsolidate, true)
    await engine.close()
  })

  await test('unrelated queries return no cards once the relevance gate is on', async () => {
    const engine = createEngine({ dataFile: join(dir, 'gate', 'memory.sqlite'), autoConsolidate: false })
    await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_gate',
      mode: 'apply',
      payload: {
        new_memories: [
          { content: '阿伟立下倒立洗头的 flag，全群围观。', keywords: ['倒立洗头', '阿伟'], importance: 9 },
        ],
      },
    })
    const hit = await engine.recallFor({
      platform: 'qq',
      scopeId: 'group_gate',
      query: '阿伟倒立洗头',
      limit: 3,
      reinforce: false,
    })
    assert.equal(hit.items.length, 1)
    const miss = await engine.recallFor({
      platform: 'qq',
      scopeId: 'group_gate',
      query: '今天天气怎么样',
      limit: 3,
      reinforce: false,
    })
    assert.equal(miss.items.length, 0, 'noise floor must not surface an unrelated card')
    await engine.close()
  })

  await test('core promotion requires importance and core score', async () => {
    const engine = createEngine({ dataFile: join(dir, 'core-gate', 'memory.sqlite'), autoConsolidate: false })
    await engine.consolidate({
      platform: 'qq',
      scopeId: 'group_core',
      mode: 'apply',
      payload: {
        new_memories: [
          { content: '低分日常一', keywords: ['低分一'], importance: 4 },
          { content: '低分日常二', keywords: ['低分二'], importance: 5 },
          { content: '低分日常三', keywords: ['低分三'], importance: 5.5 },
          { content: '重要名场面', keywords: ['名场面'], importance: 7 },
        ],
      },
    })
    const store = await engine.ensureReady()
    const core = store.allNotes().filter((note) => note.strategy === 'constant')
    assert.equal(core.length, 1, `only the qualified card should be core: ${JSON.stringify(core.map((note) => note.importance))}`)
    assert.equal(core[0].importance, 7)
    await engine.close()
  })

  await test('Tier-0 prompt budget truncates long core cards', () => {
    const long = '很长的记忆内容'.repeat(80)
    const notes = Array.from({ length: 10 }, (_, index) => ({
      content: long,
      importance: 9 - index * 0.1,
      archived: false,
    }))
    const text = formatCoreMemories(notes)
    assert.ok(text.length <= 1220, `prompt core block too long: ${text.length}`)
    assert.ok(text.split('\n').length <= 8, 'the core block must stop at the total budget')
    assert.ok(text.includes('…'))
  })
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    console.warn(`(cleanup skipped for ${dir})`)
  }
}

console.log(`\n${passed} tests passed`)
