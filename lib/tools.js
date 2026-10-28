/**
 * Model-facing tools.
 *
 * Every tool is a thin wrapper over the engine facade; the same operations
 * are exposed to the Web panel over the plugin's HTTP route, so the UI and
 * the agent cannot drift apart.
 */

const PLATFORMS = ['qq', 'bilibili', 'douyin', 'global']

const text = (value) => [{ type: 'text', text: value }]

const objectOutput = (render) => ({
  schema: { type: 'object', additionalProperties: true },
  render,
})

function shortId(id) {
  return String(id).slice(0, 8)
}

function formatScore(score) {
  return [
    `绿灯${score.greenlight_score.toFixed(2)}`,
    `熟人${Math.round(score.user_match_score * 100)}`,
    `语义${Math.round(score.vector_score * 100)}`,
    `联想${Math.round(score.ppr_score * 100)}`,
    `重要${Math.round(score.importance_score * 100)}`,
    `保鲜${Math.round(score.ebbinghaus_retention * 100)}`,
  ].join('·')
}

export function registerTools(ctx, engine, config = {}) {
  const disposers = []

  disposers.push(
    ctx.tools.register({
      name: 'memory_ingest',
      description:
        '把 QQ群、B站评论/直播弹幕、抖音弹幕等社交流水写入大肥鱼的本地长期记忆库。入库前会做噪声过滤：纯复读、纯表情包、单字刷屏只留在短期上下文，不进入记忆总结池。支持单条或 messages 批量。',
      parameters: {
        type: 'object',
        properties: {
          platform: { type: 'string', enum: PLATFORMS, description: '来源平台。global 表示跨平台通用。' },
          scope_id: { type: 'string', description: "隔离域：QQ 群用 'group_<群号>'，私聊用 'private_<QQ号>'，评论串/直播间用视频号或 room id，跨平台通用记忆用 'global'。" },
          user_id: { type: 'string', description: '说话人的平台 UID（QQ号、B站UID、抖音号）。' },
          nickname: { type: 'string', description: '说话人当前昵称或群名片。' },
          content: { type: 'string', description: '消息原文。单条入库时必填。' },
          greenlight_hits: { type: 'array', items: { type: 'string' }, description: '可选：本消息命中的已知梗词/绿灯词，用于提高本条消息的价值分。' },
          messages: {
            type: 'array',
            description: '批量入库时的消息数组；给出后忽略顶层的单条字段。',
            items: {
              type: 'object',
              properties: {
                platform: { type: 'string', enum: PLATFORMS },
                scope_id: { type: 'string' },
                user_id: { type: 'string' },
                nickname: { type: 'string' },
                content: { type: 'string' },
                greenlight_hits: { type: 'array', items: { type: 'string' } },
              },
              required: ['content'],
              additionalProperties: true,
            },
          },
        },
        additionalProperties: false,
      },
      output: objectOutput((args, value) => {
        if (!value) return text('入库失败：没有返回结果。')
        if (Array.isArray(value.items)) {
          const lines = [`批量入库 ${value.items.length} 条：`]
          for (const item of value.items) {
            lines.push(
              `- #${item.id} ${item.admitted ? '采纳' : '仅短期'}（噪声分 ${item.gateScore}）${item.gateReasons?.length ? ' · ' + item.gateReasons.join('、') : ''}`,
            )
          }
          lines.push(`当前待整合 ${value.pendingAdmitted} 条${value.suggestConsolidate ? '，已达到批量整合阈值。' : '。'}`)
          return text(lines.join('\n'))
        }
        return text(
          [
            `已入库 #${value.id}：${value.admitted ? '进入长期记忆总结池' : '仅滑入短期上下文，不进总结池'}。`,
            `噪声分 ${value.gateScore}${value.gateReasons?.length ? '（' + value.gateReasons.join('、') + '）' : ''}；当前待整合 ${value.pendingAdmitted} 条${value.suggestConsolidate ? '，建议调用 memory_consolidate。' : '。'}`,
          ].join('\n'),
        )
      }),
      async execute(args = {}) {
        if (Array.isArray(args.messages) && args.messages.length) {
          const items = []
          for (const message of args.messages.slice(0, 100)) {
            items.push(
              await engine.ingest({
                platform: message.platform || args.platform || 'global',
                scopeId: message.scope_id || message.scopeId || args.scope_id || args.scopeId || 'global',
                userId: message.user_id || message.userId || args.user_id || args.userId,
                nickname: message.nickname,
                content: message.content,
                greenlightHits: message.greenlight_hits || message.greenlightHits,
              }),
            )
          }
          const last = items[items.length - 1]
          return { items, pendingAdmitted: last.pendingAdmitted, suggestConsolidate: last.suggestConsolidate }
        }
        return engine.ingest({
          platform: args.platform || 'global',
          scopeId: args.scope_id || args.scopeId || 'global',
          userId: args.user_id || args.userId,
          nickname: args.nickname,
          content: args.content,
          greenlightHits: args.greenlight_hits || args.greenlightHits,
        })
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'memory_recall',
      description:
        '从大肥鱼长期记忆库唤醒与当前消息最相关的记忆卡片（默认最多 3 张，可能为空）。六维混合打分：绿灯关键词、说话人关联、向量语义、海马体图谱、重要度、艾宾浩斯保鲜度；返回每张卡的分项分数、触发词和原文。没有达到相关性门槛时返回空，避免无关打捞。被唤醒的卡默认复习加固，只预览时传 reinforce=false。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '当前消息或检索意图。' },
          platform: { type: 'string', enum: PLATFORMS, description: '当前平台，默认 global。' },
          scope_id: { type: 'string', description: '当前群号/评论串/直播间，默认 global。' },
          user_id: { type: 'string', description: '当前说话人 UID；有它时会优先想起和这个人有关的记忆。' },
          limit: { type: 'number', description: '返回卡片数上限，1-10，默认 3；可能少于上限甚至为空。' },
          scope_mode: {
            type: 'string',
            enum: ['shared_global', 'strict', 'cross_platform'],
            description: "strict=只在本群唤醒；shared_global=本群+全局（默认）；cross_platform=全库跨平台联想。",
          },
          reinforce: { type: 'boolean', description: '是否对唤醒结果做复习加固，默认 true；只做分数预览时传 false。' },
          min_score: { type: 'number', description: '可选：覆盖本次最终分门槛（0-1，默认 0.25）。' },
          min_vector: { type: 'number', description: '可选：覆盖本次向量分门槛（0-1，默认 0.20）。' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: objectOutput((args, value) => {
        if (!value?.items?.length) {
          return text(`没有唤醒任何记忆（候选 ${value?.poolSize ?? 0} 张）。`)
        }
        const lines = [
          `场景 ${value.scene}｜候选 ${value.poolSize} 张｜窗口：${(value.window || '').replace(/\n/g, ' / ').slice(0, 160)}`,
        ]
        for (const item of value.items) {
          lines.push(
            '',
            `● ${item.content}`,
            `  ${item.strategy === 'constant' ? '[核心常驻]' : '[按需唤醒]'} 重要度 ${item.importance} · 强度 ${item.strength} · 被想起 ${item.accessCount} 次${item.forcedByKeyword ? ' · 绿灯强唤醒(深层睡眠)' : ''}`,
            `  分项 ${formatScore(item.score)} → 总分 ${item.score.final_score}`,
            item.matchedKeywords?.length ? `  触发词：${item.matchedKeywords.join('、')}${item.greenlightSource === 'link' ? '（关联卡片传导）' : ''}` : '',
          )
        }
        return text(lines.filter(Boolean).join('\n'))
      }),
      async execute(args = {}) {
        if (!args.query) throw new Error('memory_recall 需要 query')
        return engine.recallFor({
          platform: args.platform || 'global',
          scopeId: args.scope_id || args.scopeId || 'global',
          scopeMode: args.scope_mode || args.scopeMode,
          userId: args.user_id || args.userId,
          query: args.query,
          limit: args.limit,
          reinforce: args.reinforce,
          minScore: args.min_score ?? args.minScore,
          minVector: args.min_vector ?? args.minVector,
        })
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'memory_consolidate',
      description:
        '睡眠整合：把待处理群聊流水提炼成 1-3 张记忆卡片并更新群友画像、好感度与状态，然后执行遗忘归档和核心记忆晋升。mode=auto 本地启发式直接整理（默认，无需模型）；mode=preview 返回整合用的系统提示与流水，供你推理后把 JSON 交给 apply 写库；mode=apply 接收 payload 写库。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['auto', 'preview', 'apply'], description: 'auto=启发式整理；preview=只生成模型输入；apply=写入 payload。' },
          platform: { type: 'string', enum: PLATFORMS, description: '要整合的平台，默认 global。' },
          scope_id: { type: 'string', description: '要整合的群/评论串/直播间，默认 global。' },
          limit: { type: 'number', description: '最多读取多少条待整合消息，默认 preview 60 / auto 80。' },
          max_cards: { type: 'number', description: 'auto 模式最多生成几张卡，默认 2。' },
          payload: {
            oneOf: [{ type: 'object' }, { type: 'string' }],
            description: 'mode=apply 时必填：整合 JSON 对象或 JSON 字符串，字段 new_memories / profile_updates。',
          },
          event_ids: { type: 'array', items: { type: 'number' }, description: 'apply 时消费掉的消息 id；省略则消费当前全部待整合消息。' },
        },
        additionalProperties: false,
      },
      output: objectOutput((args, value) => {
        if (!value) return text('整合失败：没有返回结果。')
        if (value.mode === 'preview') {
          if (value.empty) return text(`没有待整合的有效消息（${value.scene || ''}）。`)
          return text(
            [
              `待整合 ${value.pending} 条（${value.scene}）。`,
              '下面是把本轮流水交给后台记忆引擎的完整输入。请按系统提示输出 JSON，然后调用 memory_consolidate mode=apply 写回：',
              '',
              '--- SYSTEM ---',
              value.system_prompt,
              '--- USER ---',
              value.user_prompt,
            ].join('\n'),
          )
        }
        const lines = [`整合完成（${value.scene || value.mode}）：新增 ${value.created?.length ?? 0} 张卡片${value.skipped?.length ? `，跳过 ${value.skipped.length} 张` : ''}。`]
        for (const card of value.created || []) lines.push(`- ${card.importance}分 · 触发词 ${card.keywords?.join('、') || '（无）'} · id ${card.id}`)
        if (value.updatedProfiles?.length) {
          lines.push(`画像更新 ${value.updatedProfiles.length} 人：` + value.updatedProfiles.map((p) => `${p.userId}(好感度 ${Math.round(p.affection)})`).join('、'))
        }
        const maintenance = value.maintenance
        if (maintenance) {
          lines.push(
            `维护：归档 ${maintenance.archived?.length || 0} 张、晋升核心 ${maintenance.promoted?.length || 0} 张、退居按需 ${maintenance.demoted || 0} 张。`,
          )
        }
        if (value.skipped?.length) lines.push(`跳过原因：${value.skipped.join('；')}`)
        return text(lines.join('\n'))
      }),
      async execute(args = {}) {
        return engine.consolidate({
          mode: args.mode || 'auto',
          platform: args.platform || 'global',
          scopeId: args.scope_id || args.scopeId || 'global',
          limit: args.limit,
          maxCards: args.max_cards || args.maxCards,
          payload: args.payload,
          eventIds: args.event_ids || args.eventIds,
        })
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'memory_profile',
      description:
        '查看或修改群友/粉丝画像：好感度（0-100）、关系阶段、大肥鱼给对方起的专属外号、当前有效状态键值对。状态键值对采用覆写语义：同一个键的新值会让旧值失效，历史仍可查询。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'get', 'update', 'history'], description: 'list 列表（默认）、get 单人档案、update 修改、history 状态变更历史。' },
          platform: { type: 'string', enum: PLATFORMS, description: '平台，默认 global。' },
          user_id: { type: 'string', description: '用户平台 UID；get/update/history 必填。' },
          nickname: { type: 'string', description: '最新昵称。' },
          alias: { type: 'string', description: '大肥鱼给对方起的专属外号。' },
          stage: { type: 'string', description: '关系阶段，如 死忠粉/损友/老熟人/黑名单。' },
          affection_delta: { type: 'number', description: '好感度增量，-5 到 +5。' },
          facts: { type: 'object', description: '要覆写的状态键值对（字符串值），如 {"近期动态":"考研备战中"}。' },
          limit: { type: 'number', description: 'list 返回上限，默认 50。' },
        },
        additionalProperties: false,
      },
      output: objectOutput((args, value) => {
        if (!value) return text('没有返回结果。')
        if (value.action === 'update') {
          const p = value.profile
          return text(
            `已更新 ${p.platform}:${p.userId}｜昵称 ${p.nickname}｜外号 ${p.botNicknameForUser || '（无）'}｜关系 ${p.relationshipStage}｜好感度 ${p.affectionScore}（${value.affectionDelta >= 0 ? '+' : ''}${value.affectionDelta}）`,
          )
        }
        if (value.action === 'history') {
          return text(
            value.facts?.length
              ? value.facts.map((fact) => `- ${fact.key} = ${fact.value}（${fact.validFrom.slice(0, 10)}${fact.invalidAt ? ' → ' + fact.invalidAt.slice(0, 10) : ' 至今'}）`).join('\n')
              : '该用户还没有状态变更历史。',
          )
        }
        if (value.action === 'get') {
          if (!value.profile) return text('没有找到该用户的画像。')
          const p = value.profile
          const facts = Object.entries(p.activeFacts || {}).map(([k, v]) => `${k}: ${v}`).join('；')
          return text(`${p.platform}:${p.userId}｜${p.nickname}｜外号 ${p.botNicknameForUser || '（无）'}｜${p.relationshipStage}｜好感度 ${p.affectionScore}\n状态：${facts || '（无）'}`)
        }
        const profiles = value.profiles || []
        if (!profiles.length) return text('画像库还是空的。')
        return text(
          profiles
            .map((p) => `- ${p.platform}:${p.userId} ${p.nickname}${p.botNicknameForUser ? `（${p.botNicknameForUser}）` : ''}｜${p.relationshipStage}｜好感度 ${Math.round(p.affectionScore)}`)
            .join('\n') + `\n共 ${value.total} 人。`,
        )
      }),
      async execute(args = {}) {
        return engine.profiles({
          action: args.action || 'list',
          platform: args.platform || 'global',
          userId: args.user_id || args.userId,
          nickname: args.nickname,
          alias: args.alias,
          stage: args.stage,
          affectionDelta: args.affection_delta ?? args.affectionDelta,
          facts: args.facts,
          limit: args.limit,
        })
      },
    }),
  )

  disposers.push(
    ctx.tools.register({
      name: 'memory_notes',
      description:
        '记忆卡片与引擎维护：list 列表、search 全文检索、get 单卡详情、archive 归档/恢复（归档后只在有人说出它的绿灯词时才会被想起）、delete 永久删除、maintain 立即执行遗忘归档与核心晋升、stats 引擎统计。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search', 'get', 'archive', 'delete', 'maintain', 'stats'], description: '操作，默认 list。' },
          id: { type: 'string', description: '卡片 id，get/archive/delete 必填。' },
          query: { type: 'string', description: 'search 的检索词。' },
          platform: { type: 'string', enum: PLATFORMS, description: '按平台过滤。' },
          scope_id: { type: 'string', description: '按隔离域过滤。' },
          archived: { type: 'boolean', description: 'list 过滤：true 只看已归档，false 只看活跃；省略表示包含两种。' },
          limit: { type: 'number', description: '返回上限，默认 50。' },
          offset: { type: 'number', description: 'list 分页偏移。' },
        },
        additionalProperties: false,
      },
      output: objectOutput((args, value) => {
        if (!value) return text('没有返回结果。')
        if (value.action === 'stats') {
          const s = value.stats
          return text(
            [
              `引擎 ${s.backend} 后端，FTS=${s.fts ? '开启' : '关闭'}，向量=${s.vectorIndex}`,
              `卡片 ${s.notes}（归档 ${s.archived}）｜画像 ${s.profiles}｜流水 ${s.events}（待整合 ${s.pendingEvents}）｜核心常驻 ${s.core?.length ?? 0}`,
              `数据文件：${s.file}`,
              s.maintenance ? `上次维护：${s.maintenance.at}（归档 ${s.maintenance.archived}、晋升 ${s.maintenance.promoted}）` : '尚未维护过。',
            ].join('\n'),
          )
        }
        if (value.action === 'archive') return text(`卡片 ${value.id} 已${value.archived ? '归档（深层睡眠，等绿灯词唤醒）' : '恢复'}。`)
        if (value.action === 'delete') return text(`卡片 ${value.id} 已永久删除。`)
        if (value.action === 'maintain') {
          return text(`维护完成：归档 ${value.archived.length} 张，晋升核心 ${value.promoted.length} 张，退居按需 ${value.demoted} 张。`)
        }
        if (value.action === 'get') {
          if (!value.note) return text('没有找到该卡片。')
          const n = value.note
          return text(
            `【${n.platform}/${n.scopeId}】${n.strategy === 'constant' ? '核心常驻' : '按需唤醒'}${n.archived ? '·已归档' : ''}\n${n.content}\n触发词：${n.keywords.join('、') || '（无）'}｜重要度 ${n.importance}｜强度 ${n.strength}｜想起 ${n.accessCount} 次\n背景：${n.contextSummary || '（无）'}`,
          )
        }
        const notes = value.notes || []
        if (!notes.length) return text('没有匹配的记忆卡片。')
        const lines = notes.map(
          (n) =>
            `- ${n.id}｜${n.platform}/${n.scopeId}｜${n.importance}分${n.archived ? '·归档' : ''}${n.strategy === 'constant' ? '·核心' : ''}｜${n.content.slice(0, 80)}${n.content.length > 80 ? '…' : ''}`,
        )
        return text(lines.join('\n'))
      }),
      async execute(args = {}) {
        return engine.notes({
          action: args.action || 'list',
          id: args.id,
          query: args.query,
          platform: args.platform,
          scopeId: args.scope_id || args.scopeId,
          archived: args.archived,
          limit: args.limit,
          offset: args.offset,
        })
      },
    }),
  )

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
