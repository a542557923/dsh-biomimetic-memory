# 仿生分层记忆引擎（DeepSeek Harness 插件）

按 `rp_biomimetic_memory_spec.md` 落地的 **多平台社交角色扮演仿生记忆引擎**，装进当前 Harness 后提供：

- 5 个模型可调用工具：`memory_ingest` / `memory_recall` / `memory_consolidate` / `memory_profile` / `memory_notes`
- 每次组装的系统提示上下文：Tier-0 核心记忆 + 鱼塘熟人 + 工具使用约定
- Web GUI 里的「仿生记忆引擎」面板：卡片浏览/检索/归档/删除、群友画像、六维唤醒试算
- 后台每 10 分钟扫描一次：攒够 40 条有效消息自动批量整合，每日 04:00 后自动遗忘归档与核心晋升

数据落在**单个本地文件**里，无需 Milvus / Neo4j / Redis 等外部进程。

## 仓库结构

- 根目录：DeepSeek Harness 插件（工具、系统提示上下文、Web 面板、`lib/bridge.mjs` 本地记忆桥）
- [`astrbot-adapter/`](astrbot-adapter/README.md)：AstrBot 适配器插件，把 AstrBot（NapCat/OneBot v11）接入同一个 SQLite
- [`test/`](test)：引擎与工具/HTTP 的 Node 测试
- `docs/`：本地 API 取证笔记（不随仓库发布）

## 与规范的对应关系

| 规范章节 | 本插件实现 |
| --- | --- |
| §2 入口噪声过滤 + 四层上下文 | `lib/greenlight.js` 噪声门；`lib/prompt.js` Tier0/Tier1/Tier3 组装（`buildRoleplayMessages`）+ Harness 用的精简上下文 |
| §3 数据模型 / SQLite Schema | `lib/store.js`：`memory_notes`、`memory_notes_fts`(FTS5 trigram)、`memory_embeddings`、`user_profiles`、`profile_fact_history`、`memory_events`、`meta` |
| §4.1 艾宾浩斯遗忘 | `lib/scoring.js`：`R = exp(-Δt/(5·S))`，唤醒后 `S += 0.5·(1+importance/10)`，`R<0.15 且 importance<6` 归档 |
| §4.2 六维混合打分 | `lib/retriever.js`：绿灯 0.30 / 说话人 0.20 / 语义 0.20 / PPR 0.10 / 重要度 0.10 / 保鲜度 0.10，返回逐项分 |
| §4.2 核心晋升 | `lib/consolidator.js`：`CoreScore = 0.6·imp/10 + 0.4·tanh((S-1)/5)`，Top 8 设为 `constant` |
| §5.1 后台总结 Prompt | `lib/prompt.js` 的 `CONSOLIDATION_SYSTEM_PROMPT`；`memory_consolidate` 的 `preview` 模式把完整模型输入交回给当前 Agent |
| §5.2 四层消息组装 | `buildRoleplayMessages()` 可直接给 OneBot / B站 / 抖音适配器复用 |
| §6 目录结构 | `lib/` 按 store / greenlight / retriever / consolidator / prompt_builder 拆分；`lib/http.js` 是面板 API |
| 检查清单 1 零外部数据库 | 单文件 SQLite；`sqlite-vec` 缺失时自动降级为 **BLOB + 精确余弦**（Node 24 内置 SQLite 无 vec0，实测已走降级路径） |
| 检查清单 2 多群隔离 | `memory_recall` 的 `scope_mode`：`strict` / `shared_global`（默认）/ `cross_platform`；画像按 `platform+user_id` 跨群共享 |
| 检查清单 3 攒批异步 | `lib/engine.js` 的 `backgroundSweep()` + ingest 达阈值时 `setTimeout(…, 0)` 异步触发，不在回复主链路 |
| 检查清单 4 可观测性 | 每张唤醒卡都带 `greenlight_score / user_match_score / vector_score / ppr_score / importance_score / ebbinghaus_retention / final_score`，面板「唤醒调试」可视化 |

## 安装

在本仓库目录下由 Harness 的 `plugin_manager` 安装：

```powershell
# 在 Harness 里由 Agent 调用；target 指向本仓库的绝对路径
plugin_manager install_bundle target="<本仓库绝对路径>"
```
```

安装后在 Web GUI 左侧栏出现鱼形图标，点开即面板。插件行标题为「仿生分层记忆引擎」。

## 数据文件

默认：`~/.dsh/data/biomimetic-memory/memory.sqlite`；若 Host 进程设置了 `DSH_PROFILE_DIR`，则落在 `<$DSH_PROFILE_DIR>/data/biomimetic-memory/memory.sqlite`。

可用环境变量覆盖：

| 变量 | 作用 |
| --- | --- |
| `DSH_BIOMIMETIC_MEMORY_DB` | 指定完整 `.sqlite` 路径 |
| `DSH_BIOMIMETIC_STORE=json` | 强制 JSON 单文件后端（调试/极端环境） |

`.sqlite-wal` / `.sqlite-shm` 是 SQLite 正常日志文件；备份时复制主文件即可（或先停 Harness）。

## 工具速查

| 工具 | 关键参数 | 返回 |
| --- | --- | --- |
| `memory_ingest` | `platform`、`scope_id`、`user_id`、`nickname`、`content`；或 `messages[]` | 采纳/仅短期、噪声分与理由、待整合条数、是否达批量阈值 |
| `memory_recall` | `query`、`platform`、`scope_id`、`user_id`、`limit`、`scope_mode`、`reinforce` | Top-K 卡片 + 六维分项 + 触发词；默认复习加固 |
| `memory_consolidate` | `mode=auto\|preview\|apply`、`platform`、`scope_id`、`payload` | 新模式：卡片/画像/维护结果；preview 模式返回整合 Prompt 与流水 |
| `memory_profile` | `action=list\|get\|update\|history`、`user_id`、`affection_delta`、`facts` | 画像、好感度、状态覆写历史 |
| `memory_notes` | `action=list\|search\|get\|archive\|delete\|maintain\|stats` | 卡片管理 / 维护 / 统计 |

典型用法：

```text
用户：记得阿伟上次立的倒立洗头 flag 吗？
Agent → memory_recall {platform:"qq", scope_id:"group_123", user_id:"12345678", query:"阿伟 倒立洗头"}
Agent ← 命中「倒立洗头」绿灯卡，附带 2026-10-20 的原话与分数明细
```

无模型密钥也能整理记忆：`memory_consolidate {mode:"auto"}` 走本地启发式（分词、承诺/里程碑信号、画像好感度）。想用 DeepSeek 产出更高质量的卡片：`preview` → 自己按返回的 Prompt 输出 JSON → `apply`。

## 面板

- **记忆卡片**：平台/隔离域筛选、内容与绿灯词检索、重要度徽章、强度/想起次数/上次想起、归档恢复、二次确认删除
- **群友画像**：昵称、专属外号、关系阶段、好感度进度条、当前有效状态
- **唤醒调试**：输入模拟消息 + 说话人，查看六维打分与触发词（不写库、不加固）
- 顶部：刷新 / 遗忘与晋升 / 睡眠整合（后台整理当前筛选的群或全域）

## 自测

```powershell
cd <本仓库>
node test/engine.test.mjs   # 11 项：存储、噪声门、遗忘归档、绿灯强唤醒、链接、隔离、批量阈值…
node test/tools.test.mjs    # 3 项：5 个工具注册/渲染、认证 API、裸路由鉴权
```

`docs/dsh-plugin-api-notes.md` 记录了本插件依赖的 Harness 插件 API 取证（工具定义、prompt context 顺序、`/api` fetch 路由、locale、slot 注册）。

## 已知边界

- 本插件是 **Harness 侧记忆引擎**：它提供工具与面板，不内置 QQ/B站/抖音 长连接。实际接入时由 OneBot/AstrBot 适配器把事件转成 `memory_ingest` 调用（`lib/prompt.js` 的 `buildRoleplayMessages` 可直接用于回复组装）。
- 向量是本地 512 维哈希嵌入（CJK 字/二元/三元组 + 拉丁词），不依赖 Embedding API；它服务于「同义词兜底」，精度低于专业嵌入模型，绿灯词与说话人关联仍是主信号。
- 未内置 LLM 密钥：`preview` 模式把整合 Prompt 交给当前 Agent 完成；`auto` 模式是纯本地启发式。
- 面板数据通道优先走 Connection 的鉴权路由 `/api/biomimetic-memory`，同时保留 `/biomimetic-memory/` 裸路由兜底；裸路由要求 `x-biomimetic-memory: 1` 请求头。
