# 仿生分层记忆引擎适配器（AstrBot 侧）

把 AstrBot 的 QQ 群聊/私聊接到 DSH 的仿生分层记忆引擎。装上后大肥鱼会：

- 自动记住群里的有效对话（噪声门在记忆引擎侧，纯复读/表情包会被丢弃）；
- 在回复前按「绿灯关键词 + 说话人 + 向量 + 联想图谱 + 重要度 + 保鲜度」召回记忆；
- 把当前说话人的昵称、外号、好感度、近况注入 system prompt；
- 提供 `/memory` 指令查看状态、手动召回、立即整合。

## 架构

```text
NapCat (OneBot v11) ── ws://127.0.0.1:6199/ws ── AstrBot (aiocqhttp)
                                               │
                                    本插件 (ingest / recall / profile)
                                               │ HTTP 127.0.0.1:8787
                                    记忆桥 bridge.mjs (Node)
                                               │
                    C:\Users\<你>\.dsh\data\biomimetic-memory\memory.sqlite
                                               │
                                  DSH 仿生记忆插件（工具 + Web 面板）
```

桥接进程和 DSH 插件共用同一个 SQLite 文件；桥固定监听 8787，不受 DSH Web 端口变化影响。

## 安装

把本目录复制到 AstrBot 的插件目录并重启：

```text
<AstrBot>/data/plugins/astrbot_plugin_biomimetic_memory
```

AstrBot 启动时会自动加载。依赖只有 `aiohttp`，AstrBot 自带，无需额外安装。

## 配置

在 AstrBot WebUI「插件 → 仿生分层记忆引擎适配器 → 配置」中修改，默认值已经能跑：

- `memory_api`：`http://127.0.0.1:8787/`
- `bridge_script`：指向本仓库 DSH 插件的 `lib/bridge.mjs`；把适配器留在本仓库的 `astrbot-adapter/` 里时可留空自动找到
- `auto_start_bridge`：桥没启动时自动用 Node 启动 `bridge_script`
- `db_path`：留空用 `~/.dsh/data/biomimetic-memory/memory.sqlite`
- `auto_ingest` / `auto_recall` / `inject_profile`：默认全开
- `consolidate_threshold`：0 表示交给 DSH 插件后台整合；大于 0 时适配器攒够就整合
- `platform_allowlist`：默认只处理 `aiocqhttp`

## 指令

- `/memory status`：卡片/画像/待整合数量与桥地址
- `/memory recall 阿伟倒立洗头`：手动试算唤醒（不加固）
- `/memory consolidate`：立即整理当前群/私聊
- `/memory profile`：查看自己的画像、外号、好感度、近况

## 注意

- 需要 Node 22+（本机为 24.x）与 DSH 记忆插件源码目录；桥脚本缺失时只会在日志里告警，不会影响 AstrBot 其他功能。
- 记忆桥监听 127.0.0.1:8787，仅本机可访问；AstrBot 与 NapCat 应运行在同一台机器。
- 首次加载时适配器会调用 `/memory` 健康检查；若桥不可用，聊天照常，只是没有记忆注入。
