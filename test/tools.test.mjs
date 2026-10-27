/**
 * Tool-definition and HTTP-dispatch smoke tests.
 * Run with: node test/tools.test.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { createEngine } from '../lib/engine.js'
import { registerTools } from '../lib/tools.js'
import { createMemoryFetch, createMemoryRoute, dispatch } from '../lib/http.js'

const dir = mkdtempSync(join(process.cwd(), '.tmp-tools-'))
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

function fakeContext() {
  const tools = new Map()
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(callback) {
      return callback()
    },
    get() {
      return undefined
    },
    logger: { warn() {}, debug() {} },
  }
  return { ctx, tools }
}

function assertRendered(definition, args, value, label) {
  const content = definition.output.render(args, value)
  assert.ok(Array.isArray(content) && content.length > 0, `${label}: render returned no content`)
  assert.equal(content[0].type, 'text')
  assert.equal(typeof content[0].text, 'string')
  assert.ok(content[0].text.length > 0, `${label}: render text is empty`)
}

try {
  await test('all five tools register with supported schemas and render', async () => {
    const engine = createEngine({ dataFile: join(dir, 'tools', 'memory.sqlite'), autoConsolidate: false })
    const { ctx, tools } = fakeContext()
    const dispose = registerTools(ctx, engine)
    assert.deepEqual(
      [...tools.keys()].sort(),
      ['memory_consolidate', 'memory_ingest', 'memory_notes', 'memory_profile', 'memory_recall'].sort(),
    )
    for (const definition of tools.values()) {
      assert.ok(definition.description.length > 20)
      assert.equal(definition.parameters.type, 'object')
      assert.ok(definition.output && definition.output.schema && typeof definition.output.render === 'function')
    }

    const ingest = tools.get('memory_ingest')
    const ingestArgs = { platform: 'qq', scope_id: 'group_1', user_id: '42', nickname: '阿伟', content: '@大肥鱼 我今天抽卡又歪了七七' }
    const ingestValue = await ingest.execute(ingestArgs)
    assert.equal(ingestValue.admitted, true)
    assertRendered(ingest, ingestArgs, ingestValue, 'ingest')

    const batch = await ingest.execute({
      messages: [
        { platform: 'qq', scope_id: 'group_1', user_id: '42', nickname: '阿伟', content: '我们说好周末去吃火锅，我请客' },
        { platform: 'qq', scope_id: 'group_1', user_id: '43', nickname: '小美', content: '真的假的，截图了' },
      ],
    })
    assert.equal(batch.items.length, 2)
    assertRendered(ingest, {}, batch, 'ingest-batch')

    const consolidate = tools.get('memory_consolidate')
    const autoArgs = { mode: 'auto', platform: 'qq', scope_id: 'group_1', max_cards: 2 }
    const autoValue = await consolidate.execute(autoArgs)
    assert.ok(autoValue.created.length >= 1)
    assertRendered(consolidate, autoArgs, autoValue, 'consolidate-auto')

    const previewValue = await consolidate.execute({ mode: 'preview', platform: 'qq', scope_id: 'group_1' })
    assertRendered(consolidate, {}, previewValue, 'consolidate-preview')

    const todo = autoValue.created[0]
    const recall = tools.get('memory_recall')
    const recallArgs = { platform: 'qq', scope_id: 'group_1', user_id: '42', query: '还记得火锅请客那事吗' }
    const recallValue = await recall.execute(recallArgs)
    assert.ok(Array.isArray(recallValue.items))
    assertRendered(recall, recallArgs, recallValue, 'recall')

    const profile = tools.get('memory_profile')
    const updateArgs = { action: 'update', platform: 'qq', user_id: '42', nickname: '阿伟', alias: '非酋阿伟', stage: '损友', affection_delta: 3, facts: { 近期动态: '抽卡沉船' } }
    const updateValue = await profile.execute(updateArgs)
    assert.equal(updateValue.profile.botNicknameForUser, '非酋阿伟')
    assertRendered(profile, updateArgs, updateValue, 'profile-update')
    assertRendered(profile, { action: 'list' }, await profile.execute({ action: 'list', platform: 'qq' }), 'profile-list')
    assertRendered(profile, { action: 'get' }, await profile.execute({ action: 'get', platform: 'qq', userId: '42' }), 'profile-get')
    assertRendered(profile, { action: 'history' }, await profile.execute({ action: 'history', platform: 'qq', userId: '42' }), 'profile-history')

    const notes = tools.get('memory_notes')
    const listArgs = { action: 'list', platform: 'qq' }
    const listValue = await notes.execute(listArgs)
    assertRendered(notes, listArgs, listValue, 'notes-list')
    assertRendered(notes, { action: 'stats' }, await notes.execute({ action: 'stats' }), 'notes-stats')
    const noteId = todo.id
    assertRendered(notes, { action: 'get' }, await notes.execute({ action: 'get', id: noteId }), 'notes-get')
    const archiveValue = await notes.execute({ action: 'archive', id: noteId, archived: true })
    assert.equal(archiveValue.archived, true)
    assertRendered(notes, { action: 'archive' }, archiveValue, 'notes-archive')
    const maintainValue = await notes.execute({ action: 'maintain' })
    assertRendered(notes, { action: 'maintain' }, maintainValue, 'notes-maintain')
    const deleteValue = await notes.execute({ action: 'delete', id: noteId })
    assert.equal(deleteValue.deleted, true)
    assertRendered(notes, { action: 'delete' }, deleteValue, 'notes-delete')

    dispose()
    assert.equal(tools.size, 0)
    await engine.close()
  })

  await test('authenticated fetch route answers state/recall/consolidate', async () => {
    const engine = createEngine({ dataFile: join(dir, 'http', 'memory.sqlite'), autoConsolidate: false })
    await engine.ingest({ platform: 'qq', scopeId: 'group_2', userId: '7', nickname: '阿七', content: '@大肥鱼 我们约好今晚八点开黑，别放鸽子' })
    await engine.consolidate({ platform: 'qq', scopeId: 'group_2', mode: 'auto' })
    const handler = createMemoryFetch(engine)

    const state = await handler(
      new Request('http://localhost/api/biomimetic-memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'state', platform: 'qq', limit: 20 }),
      }),
    )
    assert.equal(state.status, 200)
    const snapshot = await state.json()
    assert.ok(snapshot.stats.notes >= 1)
    assert.ok(Array.isArray(snapshot.notes))
    assert.ok(Array.isArray(snapshot.profiles))
    assert.ok(Array.isArray(snapshot.scopes))

    const recall = await handler(
      new Request('http://localhost/api/biomimetic-memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'recall', platform: 'qq', scope_id: 'group_2', user_id: '7', query: '今晚八点开黑' }),
      }),
    )
    assert.equal(recall.status, 200)
    const recallBody = await recall.json()
    assert.ok(recallBody.items.length >= 1)
    assert.ok(recallBody.items[0].score.final_score > 0)

    const unknown = await handler(
      new Request('http://localhost/api/biomimetic-memory', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'nope' }),
      }),
    )
    assert.equal(unknown.status, 404)

    const direct = await dispatch(engine, 'notes', { action: 'stats' })
    assert.ok(direct.stats.notes >= 1)
    await engine.close()
  })

  await test('bare web-server route rejects a missing request marker', async () => {
    const engine = createEngine({ dataFile: join(dir, 'bare', 'memory.sqlite'), autoConsolidate: false })
    const handler = createMemoryRoute(engine)
    const headers = {}
    const body = []
    const req = {
      method: 'POST',
      url: '/biomimetic-memory/state',
      headers,
      on(event, listener) {
        if (event === 'end') listener()
        return this
      },
    }
    const res = {
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        body.push(chunk)
      },
    }
    await handler(req, res)
    assert.equal(res.status, 403)
    assert.match(String(body[0]), /x-biomimetic-memory/)
    await engine.close()
  })
} finally {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    console.warn(`(cleanup skipped for ${dir})`)
  }
}

console.log(`\n${passed} tests passed`)
