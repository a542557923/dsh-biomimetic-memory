/**
 * Client half: the memory management panel.
 *
 * Registered into two root slots: a sidebar icon and the matching main panel.
 * All data comes from the Host half's local route (`/biomimetic-memory/`),
 * which the panel also uses for its actions, so the UI and the agent tools run
 * exactly the same operations.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-biomimetic-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'biomimeticMemory'
    // Primary: Connection-mediated authenticated route. Fallback: bare web
    // server prefix, for compositions that mount no Connection service.
    const ENDPOINTS = ['/api/biomimetic-memory', '/biomimetic-memory/']
    let endpointIndex = 0

    const ZH = {
      title: '仿生记忆引擎',
      subtitle: '多平台社交记忆 · 六维混合唤醒 · 单文件本地存储',
      tabCards: '记忆卡片',
      tabProfiles: '群友画像',
      tabRecall: '唤醒调试',
      refresh: '刷新',
      consolidate: '睡眠整合',
      maintain: '遗忘与晋升',
      statsNotes: '记忆卡片',
      statsProfiles: '群友画像',
      statsPending: '待整合',
      statsArchived: '深层睡眠',
      statsEvents: '社交流水',
      statsBackend: '存储后端',
      statsGraph: '联想图谱',
      edges: '条边',
      impShort: '重要',
      recallCandidates: '候选',
      recallGraph: '图谱',
      recallWindow: '窗口',
      lastMaintenance: '上次维护',
      noMaintenance: '还没有维护记录',
      allPlatforms: '全部平台',
      allScopes: '全部隔离域',
      searchPlaceholder: '搜索卡片内容或绿灯词…',
      search: '搜索',
      emptyCards: '还没有记忆卡片。先用 memory_ingest 灌入几条群聊，或点右上角「睡眠整合」。',
      emptyProfiles: '还没有群友画像。整合一次群聊后会自动生成。',
      importance: '重要度',
      strength: '强度',
      recalledTimes: '想起',
      lastAccess: '上次想起',
      archivedTag: '深层睡眠',
      coreTag: '核心常驻',
      selectiveTag: '按需唤醒',
      archive: '归档',
      unarchive: '恢复',
      delete: '删除',
      confirmDelete: '确认删除',
      cancel: '取消',
      nickname: '昵称',
      alias: '外号',
      stage: '关系',
      affection: '好感度',
      facts: '当前状态',
      noFacts: '（暂无）',
      query: '模拟消息',
      queryPlaceholder: '例如：阿伟你上次不是说不出金就倒立洗头吗？',
      userPlaceholder: '说话人 UID（可空）',
      scopePlaceholder: '群号 / 评论串（可空）',
      runRecall: '试算唤醒',
      recallHint: '这里只做打分预览，不会复习加固，也不会写库。',
      loading: '加载中…',
      emptyRecall: '没有卡片达到唤醒条件。',
      finalScore: '总分',
      green: '绿灯',
      user: '熟人',
      semantic: '语义',
      ppr: '联想',
      imp: '重要',
      rec: '保鲜',
      noticeConsolidated: '整合完成',
      noticeMaintained: '维护完成',
      noticeArchived: '已归档',
      noticeRestored: '已恢复',
      noticeDeleted: '已删除',
      errorPrefix: '出错了：',
      footerFile: '数据文件',
      cardsCount: '张',
      pendingHint: '条有效消息等待整合',
      autoThreshold: '批量阈值',
    }

    const EN = {
      title: 'Biomimetic Memory',
      subtitle: 'Multi-platform social memory · six-dimension wake-up · single-file local store',
      tabCards: 'Cards',
      tabProfiles: 'Profiles',
      tabRecall: 'Recall lab',
      refresh: 'Refresh',
      consolidate: 'Sleep consolidate',
      maintain: 'Forget & promote',
      statsNotes: 'Cards',
      statsProfiles: 'Profiles',
      statsPending: 'Pending',
      statsArchived: 'Dormant',
      statsEvents: 'Events',
      statsBackend: 'Backend',
      statsGraph: 'Graph',
      edges: 'edges',
      impShort: 'IMP',
      recallCandidates: 'Candidates',
      recallGraph: 'Graph',
      recallWindow: 'Window',
      lastMaintenance: 'Last maintenance',
      noMaintenance: 'No maintenance run yet',
      allPlatforms: 'All platforms',
      allScopes: 'All scopes',
      searchPlaceholder: 'Search content or wake words…',
      search: 'Search',
      emptyCards: 'No cards yet. Ingest some chat first, or press “Sleep consolidate”.',
      emptyProfiles: 'No profiles yet. They appear after a consolidation.',
      importance: 'Importance',
      strength: 'Strength',
      recalledTimes: 'Recalled',
      lastAccess: 'Last recalled',
      archivedTag: 'Dormant',
      coreTag: 'Core',
      selectiveTag: 'On demand',
      archive: 'Archive',
      unarchive: 'Restore',
      delete: 'Delete',
      confirmDelete: 'Confirm delete',
      cancel: 'Cancel',
      nickname: 'Nickname',
      alias: 'Alias',
      stage: 'Stage',
      affection: 'Affection',
      facts: 'Active facts',
      noFacts: '(none)',
      query: 'Message',
      queryPlaceholder: 'e.g. Didn’t you promise to stand on your head?',
      userPlaceholder: 'Speaker UID (optional)',
      scopePlaceholder: 'Group / thread (optional)',
      runRecall: 'Score recall',
      recallHint: 'Preview only: no reinforcement, no writes.',
      loading: 'Loading…',
      emptyRecall: 'No card passed the wake-up threshold.',
      finalScore: 'Final',
      green: 'Green',
      user: 'Speaker',
      semantic: 'Semantic',
      ppr: 'Graph',
      imp: 'Importance',
      rec: 'Retention',
      noticeConsolidated: 'Consolidated',
      noticeMaintained: 'Maintenance finished',
      noticeArchived: 'Archived',
      noticeRestored: 'Restored',
      noticeDeleted: 'Deleted',
      errorPrefix: 'Error: ',
      footerFile: 'Data file',
      cardsCount: 'cards',
      pendingHint: 'messages waiting for consolidation',
      autoThreshold: 'Batch threshold',
    }

    const CSS = `
.bm-root{height:100%;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:24px 28px 48px;font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
.bm-inner{max-width:1080px;margin:0 auto}
.bm-header{display:flex;align-items:flex-start;gap:16px;justify-content:space-between;flex-wrap:wrap;margin-bottom:20px}
.bm-title{font-size:20px;font-weight:650;letter-spacing:.2px}
.bm-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;margin-top:2px}
.bm-actions{display:flex;gap:8px;flex-wrap:wrap}
.bm-btn{appearance:none;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.4;font-family:inherit;transition:border-color .15s,background .15s}
.bm-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.bm-btn:disabled{opacity:.55;cursor:default}
.bm-btn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.bm-btn-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.bm-btn-sm{padding:3px 9px;font-size:12px;border-radius:6px}
.bm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;margin-bottom:18px}
.bm-stat{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;min-width:0}
.bm-stat-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm-stat-value{font-size:19px;font-weight:650;margin-top:2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bm-tabs{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:16px}
.bm-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;padding:8px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.bm-tab[aria-selected="true"]{color:var(--dsw-alias-brand-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.bm-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
.bm-input,.bm-select{font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;outline:none;min-width:0}
.bm-input:focus,.bm-select:focus{border-color:var(--dsw-alias-brand-primary)}
.bm-input-grow{flex:1 1 220px}
.bm-list{display:flex;flex-direction:column;gap:10px}
.bm-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px 14px}
.bm-card-head{display:flex;gap:10px;align-items:flex-start}
.bm-badge{flex:0 0 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:44px;padding:4px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-variant-numeric:tabular-nums}
.bm-badge-num{font-size:15px;font-weight:650;line-height:1.1}
.bm-badge-text{font-size:9.5px;color:var(--dsw-alias-label-secondary);margin-top:1px;white-space:nowrap}
.bm-card-main{flex:1 1 auto;min-width:0}
.bm-card-content{font-size:14px;line-height:1.65;word-break:break-word}
.bm-card-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11.5px;margin-top:6px}
.bm-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.bm-chip{font-size:11px;padding:1.5px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bm-chip-green{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.bm-chip-core{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.bm-chip-dormant{color:var(--dsw-alias-state-idle-primary);border-style:dashed}
.bm-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.bm-affection{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px;max-width:260px}
.bm-affection > span{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px}
.bm-profile-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}
.bm-profile{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px 14px}
.bm-profile-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bm-profile-sub{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.bm-kv{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;margin-top:8px}
.bm-kv dt{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.bm-kv dd{margin:0;min-width:0;word-break:break-word}
.bm-score-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:10px}
.bm-score{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.bm-score-bar{height:5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);margin-top:3px;overflow:hidden}
.bm-score-bar > span{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.bm-notice{margin:0 0 14px;padding:8px 12px;border-radius:8px;font-size:12.5px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-bg-layer-1)}
.bm-error{margin:0 0 14px;padding:8px 12px;border-radius:8px;font-size:12.5px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1)}
.bm-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:12px;padding:28px 18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.bm-footer{margin-top:22px;color:var(--dsw-alias-label-secondary);font-size:11px;word-break:break-all}
.bm-spin{display:inline-block;width:12px;height:12px;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:bm-spin .8s linear infinite;vertical-align:-1px;margin-right:6px}
@keyframes bm-spin{to{transform:rotate(360deg)}}
.bm-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
.bm-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:10px}
.bm-form .bm-input,.bm-form .bm-select{width:100%;box-sizing:border-box}
.bm-form-wide{grid-column:1/-1}
.bm-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin:0 0 12px}
`

    const PLATFORM_LABEL = { qq: 'QQ', bilibili: 'B站', douyin: '抖音', global: '全局' }
    const DIMENSIONS = [
      ['green', 'greenlight_score'],
      ['user', 'user_match_score'],
      ['semantic', 'vector_score'],
      ['ppr', 'ppr_score'],
      ['imp', 'importance_score'],
      ['rec', 'ebbinghaus_retention'],
    ]

    function createTranslator(ctx) {
      const fallback = (key) => ZH[key] || key
      try {
        const locale = ctx.get('locale')
        if (!locale) return fallback
        try {
          const off = locale.register(NS, { zh: ZH, en: EN })
          if (typeof off === 'function') ctx.effect(() => off)
        } catch {
          /* namespace already registered */
        }
        const bound = locale.bind(NS)
        return (key) => {
          const value = bound(key)
          return typeof value === 'string' && value.length ? value : fallback(key)
        }
      } catch {
        return fallback
      }
    }

    async function callApi(action, payload) {
      let lastError = null
      for (let attempt = 0; attempt < ENDPOINTS.length; attempt += 1) {
        const index = (endpointIndex + attempt) % ENDPOINTS.length
        let response
        try {
          response = await fetch(ENDPOINTS[index], {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'x-biomimetic-memory': '1',
            },
            body: JSON.stringify({ action, ...(payload || {}) }),
          })
        } catch (networkError) {
          lastError = networkError
          continue
        }
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok) {
          lastError = new Error((data && data.error) || `HTTP ${response.status}`)
          if (response.status === 403 || response.status === 404) continue
          throw lastError
        }
        endpointIndex = index
        return data || {}
      }
      throw lastError || new Error('memory API unreachable')
    }

    function formatDate(value) {
      if (!value) return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value).slice(0, 16)
      return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    }

    function percent(value) {
      return `${Math.round(Number(value || 0) * 100)}%`
    }

    function PanelIcon(props) {
      const size = (props && props.size) || 20
      const active = Boolean(props && props.active)
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M2.6 12c0-3.6 3.3-6.5 7.6-6.5 3.6 0 6.4 1.8 7.4 4.3L21 6.5v11l-3.4-3.3c-1 2.5-3.8 4.3-7.4 4.3C5.9 18.5 2.6 15.6 2.6 12Z',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: 8.2, cy: 11, r: 1.35, fill: color }),
        h('path', { d: 'M13 9.4c2.4 0 4.1 1.2 4.1 2.8s-1.7 2.8-4.1 2.8', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    function Stat(props) {
      const t = props.t
      return h(
        'div',
        { className: 'bm-stat' },
        h('div', { className: 'bm-stat-label' }, props.label),
        h('div', { className: 'bm-stat-value', title: props.title || '' }, props.value),
        props.hint ? h('div', { className: 'bm-stat-label', style: { marginTop: 2 } }, props.hint) : null,
      )
    }

    function ScoreBar(props) {
      const value = Number(props.value || 0)
      return h(
        'div',
        { className: 'bm-score' },
        h('div', null, `${props.label} ${value.toFixed(2)}`),
        h('div', { className: 'bm-score-bar' }, h('span', { style: { width: `${Math.max(0, Math.min(100, value * 100))}%` } })),
      )
    }

    function CardsTab(props) {
      const { t, data, busy, onAction, platform, setPlatform, scope, setScope, query, setQuery, onSearch } = props
      const notes = data.notes || []
      const scopes = data.scopes || []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'bm-toolbar' },
          h(
            'select',
            {
              className: 'bm-select',
              value: platform,
              'aria-label': t('allPlatforms'),
              onChange: (event) => setPlatform(event.target.value),
            },
            h('option', { value: '' }, t('allPlatforms')),
            ...Object.keys(PLATFORM_LABEL).map((key) => h('option', { key, value: key }, PLATFORM_LABEL[key])),
          ),
          h(
            'select',
            {
              className: 'bm-select',
              value: scope,
              'aria-label': t('allScopes'),
              onChange: (event) => setScope(event.target.value),
            },
            h('option', { value: '' }, t('allScopes')),
            ...scopes.map((entry) =>
              h('option', { key: `${entry.platform}:${entry.scopeId}`, value: entry.scopeId }, `${PLATFORM_LABEL[entry.platform] || entry.platform} · ${entry.scopeId} (${entry.count})`),
            ),
          ),
          h('input', {
            className: 'bm-input bm-input-grow',
            value: query,
            placeholder: t('searchPlaceholder'),
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onSearch()
            },
          }),
          h('button', { type: 'button', className: 'bm-btn', onClick: onSearch, disabled: Boolean(busy) }, t('search')),
        ),
        notes.length === 0
          ? h('div', { className: 'bm-empty' }, t('emptyCards'))
          : h(
              'div',
              { className: 'bm-list' },
              ...notes.map((note) => {
                const dormant = Boolean(note.archived)
                return h(
                  'article',
                  { key: note.id, className: 'bm-card' },
                  h(
                    'div',
                    { className: 'bm-card-head' },
                    h(
                      'div',
                      { className: 'bm-badge', title: `${t('importance')} ${note.importance}` },
                      h('div', { className: 'bm-badge-num' }, String(note.importance)),
                      h('div', { className: 'bm-badge-text' }, t('impShort')),
                    ),
                    h(
                      'div',
                      { className: 'bm-card-main' },
                      h('div', { className: 'bm-card-content' }, note.content),
                      h(
                        'div',
                        { className: 'bm-card-meta' },
                        h('span', null, `${PLATFORM_LABEL[note.platform] || note.platform} · ${note.scopeId}`),
                        h('span', null, `${t('strength')} ${note.strength}`),
                        h('span', null, `${t('recalledTimes')} ${note.accessCount}`),
                        h('span', null, `${t('lastAccess')} ${formatDate(note.lastAccessedAt)}`),
                        h('span', { className: 'bm-mono' }, String(note.id).slice(0, 8)),
                      ),
                      h(
                        'div',
                        { className: 'bm-tags' },
                        note.strategy === 'constant' ? h('span', { className: 'bm-chip bm-chip-core' }, t('coreTag')) : h('span', { className: 'bm-chip' }, t('selectiveTag')),
                        dormant ? h('span', { className: 'bm-chip bm-chip-dormant' }, t('archivedTag')) : null,
                        ...(note.keywords || []).slice(0, 6).map((keyword) => h('span', { key: `kw-${keyword}`, className: 'bm-chip bm-chip-green' }, keyword)),
                        ...(note.tags || []).slice(0, 3).map((tag) => h('span', { key: `tag-${tag}`, className: 'bm-chip' }, tag)),
                      ),
                      h(
                        'div',
                        { className: 'bm-card-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'bm-btn bm-btn-sm',
                            disabled: Boolean(busy),
                            onClick: () => onAction('archive', note.id, !dormant),
                          },
                          dormant ? t('unarchive') : t('archive'),
                        ),
                        note.confirm ? h(
                          'span',
                          { style: { display: 'inline-flex', gap: 6 } },
                          h(
                            'button',
                            { type: 'button', className: 'bm-btn bm-btn-sm bm-btn-danger', disabled: Boolean(busy), onClick: () => onAction('delete', note.id) },
                            t('confirmDelete'),
                          ),
                          h('button', { type: 'button', className: 'bm-btn bm-btn-sm', onClick: () => onAction('cancel-delete', note.id) }, t('cancel')),
                        ) : h(
                          'button',
                          { type: 'button', className: 'bm-btn bm-btn-sm bm-btn-danger', disabled: Boolean(busy), onClick: () => onAction('ask-delete', note.id) },
                          t('delete'),
                        ),
                      ),
                    ),
                  ),
                )
              }),
            ),
      )
    }

    function ProfilesTab(props) {
      const { t, profiles, platform } = props
      const visible = platform ? profiles.filter((profile) => profile.platform === platform) : profiles
      if (visible.length === 0) return h('div', { className: 'bm-empty' }, t('emptyProfiles'))
      return h(
        'div',
        { className: 'bm-profile-grid' },
        ...visible.map((profile) => {
          const facts = Object.entries(profile.activeFacts || {})
          return h(
            'section',
            { key: `${profile.platform}:${profile.userId}`, className: 'bm-profile' },
            h('div', { className: 'bm-profile-name' }, profile.nickname || profile.userId),
            h('div', { className: 'bm-profile-sub' }, `${PLATFORM_LABEL[profile.platform] || profile.platform} · ${profile.userId}`),
            h(
              'div',
              { className: 'bm-affection', title: `${t('affection')} ${profile.affectionScore}` },
              h('span', { style: { width: `${Math.max(0, Math.min(100, Number(profile.affectionScore) || 0))}%` } }),
            ),
            h(
              'dl',
              { className: 'bm-kv' },
              h('dt', null, t('alias')),
              h('dd', null, profile.botNicknameForUser || '—'),
              h('dt', null, t('stage')),
              h('dd', null, profile.relationshipStage || '—'),
              h('dt', null, t('affection')),
              h('dd', null, String(Math.round(profile.affectionScore))),
              h('dt', null, t('facts')),
              h(
                'dd',
                null,
                facts.length
                  ? facts.map(([key, value], index) => h('div', { key }, `${key}: ${value}`))
                  : t('noFacts'),
              ),
            ),
          )
        }),
      )
    }

    function RecallTab(props) {
      const { t, form, setForm, result, busy, onRun } = props
      const items = (result && result.items) || []
      return h(
        'div',
        null,
        h('p', { className: 'bm-hint' }, t('recallHint')),
        h(
          'div',
          { className: 'bm-form' },
          h(
            'select',
            { className: 'bm-select', value: form.platform, onChange: (event) => setForm({ ...form, platform: event.target.value }) },
            ...Object.keys(PLATFORM_LABEL).map((key) => h('option', { key, value: key }, PLATFORM_LABEL[key])),
          ),
          h('input', {
            className: 'bm-input',
            value: form.scope_id,
            placeholder: t('scopePlaceholder'),
            onChange: (event) => setForm({ ...form, scope_id: event.target.value }),
          }),
          h('input', {
            className: 'bm-input',
            value: form.user_id,
            placeholder: t('userPlaceholder'),
            onChange: (event) => setForm({ ...form, user_id: event.target.value }),
          }),
          h('input', {
            className: 'bm-input bm-form-wide',
            value: form.query,
            placeholder: t('queryPlaceholder'),
            onChange: (event) => setForm({ ...form, query: event.target.value }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') onRun()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'bm-btn bm-btn-primary', onClick: onRun, disabled: Boolean(busy) || !form.query.trim() },
            busy ? h('span', { className: 'bm-spin' }) : null,
            t('runRecall'),
          ),
        ),
        result
          ? h(
              'p',
              { className: 'bm-hint' },
              `${t('recallCandidates')} ${result.poolSize || 0} · ${t('recallGraph')} ${(result.graph && result.graph.nodes) || 0} · ${t('recallWindow')} ${(result.window || '').slice(0, 120)}`,
            )
          : null,
        !result
          ? null
          : items.length === 0
            ? h('div', { className: 'bm-empty' }, t('emptyRecall'))
            : h(
                'div',
                { className: 'bm-list' },
                ...items.map((item) =>
                  h(
                    'article',
                    { key: item.id, className: 'bm-card' },
                    h('div', { className: 'bm-card-content' }, item.content),
                    h(
                      'div',
                      { className: 'bm-card-meta' },
                      h('span', null, `${t('finalScore')} ${item.score.final_score}`),
                      h('span', null, `${PLATFORM_LABEL[item.platform] || item.platform} · ${item.scopeId}`),
                      item.forcedByKeyword ? h('span', { className: 'bm-chip bm-chip-core' }, t('archivedTag')) : null,
                    ),
                    h(
                      'div',
                      { className: 'bm-score-grid' },
                      ...DIMENSIONS.map(([labelKey, field]) =>
                        h(ScoreBar, { key: field, label: t(labelKey), value: item.score[field] }),
                      ),
                    ),
                    (item.matchedKeywords || []).length
                      ? h(
                          'div',
                          { className: 'bm-tags' },
                          ...item.matchedKeywords.map((keyword) => h('span', { key: keyword, className: 'bm-chip bm-chip-green' }, keyword)),
                        )
                      : null,
                  ),
                ),
              ),
      )
    }

    function MemoryPanel() {
      const t = TRANSLATE
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [tab, setTab] = React.useState('cards')
      const [platform, setPlatform] = React.useState('')
      const [scope, setScope] = React.useState('')
      const [query, setQuery] = React.useState('')
      const [confirmId, setConfirmId] = React.useState('')
      const [recallForm, setRecallForm] = React.useState({ platform: 'qq', scope_id: '', user_id: '', query: '' })
      const [recallResult, setRecallResult] = React.useState(null)

      const load = React.useCallback(
        async (next) => {
          setBusy('load')
          setError('')
          try {
            const chosenPlatform = next && next.platform !== undefined ? next.platform : platform
            const chosenScope = next && next.scope !== undefined ? next.scope : scope
            const chosenQuery = next && next.query !== undefined ? next.query : query
            const payload = await callApi('state', {
              platform: chosenPlatform || undefined,
              scope: chosenScope || undefined,
              q: chosenQuery || undefined,
              limit: 300,
            })
            setData(payload)
          } catch (loadError) {
            setError(String(loadError.message || loadError))
          } finally {
            setBusy('')
          }
        },
        [platform, scope, query],
      )

      React.useEffect(() => {
        void load({ platform: '', scope: '', query: '' })
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const flash = (message) => {
        setNotice(message)
        window.setTimeout(() => setNotice(''), 3200)
      }

      const runConsolidate = async () => {
        setBusy('consolidate')
        setError('')
        try {
          const result = await callApi('consolidate', {
            mode: 'auto',
            platform: platform || 'global',
            scope_id: scope || 'global',
          })
          flash(`${t('noticeConsolidated')}：+${(result.created || []).length} 张卡片，${(result.updatedProfiles || []).length} 份画像`)
          await load()
        } catch (actionError) {
          setError(String(actionError.message || actionError))
        } finally {
          setBusy('')
        }
      }

      const runMaintain = async () => {
        setBusy('maintain')
        setError('')
        try {
          const result = await callApi('notes', { action: 'maintain' })
          flash(`${t('noticeMaintained')}：归档 ${(result.archived || []).length}，晋升 ${(result.promoted || []).length}`)
          await load()
        } catch (actionError) {
          setError(String(actionError.message || actionError))
        } finally {
          setBusy('')
        }
      }

      const handleNoteAction = async (action, id, archived) => {
        if (action === 'ask-delete') {
          setConfirmId(id)
          setData((current) =>
            current
              ? { ...current, notes: current.notes.map((note) => ({ ...note, confirm: note.id === id })) }
              : current,
          )
          return
        }
        if (action === 'cancel-delete') {
          setConfirmId('')
          setData((current) =>
            current ? { ...current, notes: current.notes.map((note) => ({ ...note, confirm: false })) } : current,
          )
          return
        }
        setBusy(action)
        setError('')
        try {
          if (action === 'archive') {
            await callApi('notes', { action: 'archive', id, archived })
            flash(archived ? t('noticeArchived') : t('noticeRestored'))
          } else if (action === 'delete') {
            await callApi('notes', { action: 'delete', id })
            flash(t('noticeDeleted'))
            setConfirmId('')
          }
          await load()
        } catch (actionError) {
          setError(String(actionError.message || actionError))
        } finally {
          setBusy('')
        }
      }

      const runRecall = async () => {
        if (!recallForm.query.trim()) return
        setBusy('recall')
        setError('')
        try {
          const result = await callApi('recall', {
            platform: recallForm.platform,
            scope_id: recallForm.scope_id || 'global',
            user_id: recallForm.user_id || undefined,
            query: recallForm.query,
            limit: 5,
          })
          setRecallResult(result)
        } catch (actionError) {
          setError(String(actionError.message || actionError))
        } finally {
          setBusy('')
        }
      }

      const stats = (data && data.stats) || {}
      const notes = (data && data.notes) || []
      const scopes = (data && data.scopes) || []
      const profiles = (data && data.profiles) || []

      return h(
        'div',
        { className: 'bm-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'bm-inner' },
          h(
            'header',
            { className: 'bm-header' },
            h(
              'div',
              null,
              h('div', { className: 'bm-title' }, t('title')),
              h('div', { className: 'bm-sub' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'bm-actions' },
              h('button', { type: 'button', className: 'bm-btn', onClick: () => load(), disabled: Boolean(busy) }, t('refresh')),
              h('button', { type: 'button', className: 'bm-btn', onClick: runMaintain, disabled: Boolean(busy) }, t('maintain')),
              h('button', { type: 'button', className: 'bm-btn bm-btn-primary', onClick: runConsolidate, disabled: Boolean(busy) }, t('consolidate')),
            ),
          ),
          notice ? h('div', { className: 'bm-notice' }, notice) : null,
          error ? h('div', { className: 'bm-error' }, t('errorPrefix') + error) : null,
          h(
            'div',
            { className: 'bm-stats' },
            h(Stat, { t, label: t('statsNotes'), value: stats.notes ?? '—', hint: `${stats.archived ?? 0} ${t('archivedTag')}` }),
            h(Stat, { t, label: t('statsProfiles'), value: stats.profiles ?? '—' }),
            h(Stat, { t, label: t('statsPending'), value: stats.pendingEvents ?? '—', hint: t('pendingHint') }),
            h(Stat, { t, label: t('statsEvents'), value: stats.events ?? '—' }),
            h(Stat, { t, label: t('statsBackend'), value: stats.backend || '—', hint: stats.fts ? `FTS ${stats.fts}` : '' }),
            h(Stat, {
              t,
              label: t('statsGraph'),
              value: stats.graph ? stats.graph.nodes : '—',
              hint: stats.graph ? `${stats.graph.edges} ${t('edges')}` : '',
            }),
          ),
          h(
            'div',
            { className: 'bm-tabs', role: 'tablist' },
            ...[
              ['cards', t('tabCards')],
              ['profiles', t('tabProfiles')],
              ['recall', t('tabRecall')],
            ].map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  role: 'tab',
                  className: 'bm-tab',
                  'aria-selected': tab === key ? 'true' : 'false',
                  onClick: () => setTab(key),
                },
                label,
              ),
            ),
          ),
          busy === 'load' && !data
            ? h('div', { className: 'bm-empty' }, h('span', { className: 'bm-spin' }), t('loading'))
            : tab === 'cards'
              ? h(CardsTab, {
                  t,
                  data: { ...(data || {}), notes: notes.map((note) => ({ ...note, confirm: note.id === confirmId })) },
                  busy,
                  onAction: handleNoteAction,
                  platform,
                  setPlatform: (value) => {
                    setPlatform(value)
                    setScope('')
                    void load({ platform: value, scope: '' })
                  },
                  scope,
                  setScope: (value) => {
                    setScope(value)
                    void load({ scope: value })
                  },
                  query,
                  setQuery,
                  onSearch: () => load(),
                  scopes,
                })
              : tab === 'profiles'
                ? h(ProfilesTab, { t, profiles, platform })
                : h(RecallTab, { t, form: recallForm, setForm: setRecallForm, result: recallResult, busy, onRun: runRecall }),
          h(
            'footer',
            { className: 'bm-footer' },
            h('div', null, `${t('footerFile')}：${stats.file || '—'}`),
            h(
              'div',
              null,
              `${t('autoThreshold')} ${stats.autoThreshold ?? '—'} · ${t('statsArchived')} ${stats.archived ?? 0} / ${t('statsNotes')} ${stats.notes ?? 0}`,
            ),
            h(
              'div',
              null,
              stats.maintenance
                ? `${t('lastMaintenance')}: ${formatDate(stats.maintenance.at)}`
                : t('noMaintenance'),
            ),
          ),
        ),
      )
    }

    let TRANSLATE = (key) => ZH[key] || key

    return {
      inject: ['slots'],
      apply(ctx) {
        TRANSLATE = createTranslator(ctx)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: 'biomimetic-memory',
              order: 20,
              label: () => TRANSLATE('title'),
            },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: 'biomimetic-memory',
            },
            MemoryPanel,
          ),
        )
      },
    }
  },
})
