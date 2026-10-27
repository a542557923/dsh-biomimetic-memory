"""AstrBot adapter for the DSH biomimetic layered memory engine.

The plugin connects AstrBot to a local memory bridge (``lib/bridge.mjs`` of the
DSH memory plugin).  It ingests QQ group/private messages, injects recalled
memories and social profiles into the LLM system prompt, and exposes a
``/memory`` command for diagnostics and manual consolidation.

It intentionally keeps the memory engine out of AstrBot's process: the same
SQLite file is shared by the Harness plugin (tools + Web panel) and this
adapter, through the bridge's fixed loopback port.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

import aiohttp

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star

DEFAULT_BRIDGE_PORT = 8787
DEFAULT_BRIDGE_SCRIPT = os.environ.get("DSH_BIOMIMETIC_BRIDGE_SCRIPT", "")
DEFAULT_DB = str(Path.home() / ".dsh" / "data" / "biomimetic-memory" / "memory.sqlite")
MAX_MESSAGE_CHARS = 2000


class MemoryUnavailable(RuntimeError):
    """Raised when the memory bridge cannot be reached."""


class MemoryApiError(RuntimeError):
    """Raised when the bridge answers with a business error."""


class BiomimeticMemoryPlugin(Star):
    """Bridge AstrBot events into the DSH memory engine and back."""

    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context, config)
        self.config: dict[str, Any] = config or {}
        self._session: aiohttp.ClientSession | None = None
        self._tasks: set[asyncio.Task] = set()
        self._bridge_process: asyncio.subprocess.Process | None = None
        self._bridge_checked = False
        self._last_warning = 0.0
        self._pending: dict[str, int] = {}

    # ------------------------------------------------------------------ config
    def _cfg(self, key: str, default: Any) -> Any:
        value = self.config.get(key, default)
        return default if value is None else value

    def _base_url(self) -> str:
        configured = str(self._cfg("memory_api", "") or "").strip()
        if configured and configured.lower() != "auto":
            return configured.rstrip("/") + "/"
        return f"http://127.0.0.1:{int(self._cfg('bridge_port', DEFAULT_BRIDGE_PORT))}/"

    def _bridge_script(self) -> Path:
        configured = str(self._cfg("bridge_script", "") or "").strip()
        if configured:
            return Path(configured).expanduser()
        env = str(os.environ.get("DSH_BIOMIMETIC_BRIDGE_SCRIPT", "") or "").strip()
        if env:
            return Path(env).expanduser()
        # Repository layout: <repo>/astrbot-adapter/main.py + <repo>/lib/bridge.mjs
        return Path(__file__).resolve().parent.parent / "lib" / "bridge.mjs"

    def _db_path(self) -> str:
        return str(self._cfg("db_path", "") or DEFAULT_DB)

    def _timeout(self, key: str = "timeout", default: float = 8.0) -> float:
        try:
            return max(1.0, float(self._cfg(key, default)))
        except (TypeError, ValueError):
            return default

    # ------------------------------------------------------------------- http
    async def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    async def _post_raw(self, base: str, action: str, payload: dict | None, timeout: float) -> dict:
        session = await self._get_session()
        body = {
            "action": action,
            **{key: value for key, value in (payload or {}).items() if key != "action"},
        }
        timeout_cfg = aiohttp.ClientTimeout(total=timeout)
        try:
            async with session.post(
                base,
                json=body,
                headers={"x-biomimetic-memory": "1"},
                timeout=timeout_cfg,
            ) as response:
                text = await response.text()
                if response.status >= 400:
                    raise MemoryApiError(f"HTTP {response.status}: {text[:200]}")
                try:
                    return json.loads(text)
                except json.JSONDecodeError as error:
                    raise MemoryApiError(f"invalid JSON: {error}") from error
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as error:
            raise MemoryUnavailable(f"{base} unreachable: {error}") from error

    async def _probe(self, base: str, timeout: float = 2.5) -> bool:
        try:
            await self._post_raw(base, "health", {}, timeout)
            return True
        except Exception:  # noqa: BLE001 - any failure means "not ready"
            return False

    async def _call(self, action: str, payload: dict | None = None, timeout: float | None = None) -> dict:
        base = self._base_url()
        try:
            return await self._post_raw(base, action, payload, timeout or self._timeout())
        except MemoryUnavailable:
            # A transient bridge restart: retry once after making sure it runs.
            await self._ensure_bridge()
            return await self._post_raw(base, action, payload, timeout or self._timeout())

    # ---------------------------------------------------------------- bridge
    async def _ensure_bridge(self) -> None:
        base = self._base_url()
        if await self._probe(base):
            self._bridge_checked = True
            return
        if not bool(self._cfg("auto_start_bridge", True)):
            raise MemoryUnavailable(f"memory bridge is not running at {base}")
        script = self._bridge_script()
        if not script.is_file():
            raise MemoryUnavailable(f"bridge script not found: {script}")
        node = str(self._cfg("node_path", "") or "").strip() or shutil.which("node")
        if not node:
            raise MemoryUnavailable("node executable not found (configure node_path)")

        env = os.environ.copy()
        env["DSH_BIOMIMETIC_MEMORY_DB"] = self._db_path()
        env["DSH_BIOMIMETIC_BRIDGE_PORT"] = str(int(self._cfg("bridge_port", DEFAULT_BRIDGE_PORT)))
        kwargs: dict[str, Any] = {
            "cwd": str(script.parent),
            "env": env,
            "stdout": asyncio.subprocess.DEVNULL,
            "stderr": asyncio.subprocess.DEVNULL,
        }
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
        logger.info("biomimetic memory: starting bridge %s", script)
        self._bridge_process = await asyncio.create_subprocess_exec(node, str(script), **kwargs)

        deadline = time.monotonic() + 20.0
        while time.monotonic() < deadline:
            if await self._probe(base):
                self._bridge_checked = True
                logger.info("biomimetic memory: bridge ready at %s", base)
                return
            if self._bridge_process.returncode is not None:
                raise MemoryUnavailable("memory bridge exited before becoming ready")
            await asyncio.sleep(0.5)
        raise MemoryUnavailable("memory bridge did not become ready in time")

    # ------------------------------------------------------------------ hooks
    @filter.on_astrbot_loaded()
    async def on_loaded(self) -> None:
        """Start or discover the bridge once AstrBot finished loading."""
        try:
            await self._ensure_bridge()
            health = await self._call("health")
            stats = health.get("stats", {})
            logger.info(
                "biomimetic memory ready: %s cards, %s profiles, bridge=%s",
                stats.get("notes"),
                stats.get("profiles"),
                self._base_url(),
            )
        except Exception as error:  # noqa: BLE001 - a missing bridge must not break AstrBot
            self._warn(f"memory bridge unavailable: {error}")

    @filter.event_message_type(filter.EventMessageType.ALL)
    async def capture_message(self, event: AstrMessageEvent) -> None:
        """Feed every user message into the memory engine's noise gate."""
        if not bool(self._cfg("auto_ingest", True)):
            return
        if not self._platform_allowed(event):
            return
        content = (event.message_str or "").strip()
        if not content or len(content) > MAX_MESSAGE_CHARS:
            return
        sender_id = str(event.get_sender_id() or "")
        if sender_id and sender_id == str(event.get_self_id() or ""):
            return
        self._spawn(self._ingest(event, content))

    @filter.on_llm_request()
    async def inject_memories(self, event: AstrMessageEvent, req: ProviderRequest) -> None:
        """Recall cards for the current message and append them to the prompt."""
        if not bool(self._cfg("auto_recall", True)):
            return
        if not self._platform_allowed(event):
            return
        query = (event.message_str or req.prompt or "").strip()
        if len(query) < 2:
            return
        payload = {
            "platform": self._platform(event),
            "scope_id": self._scope(event),
            "user_id": self._user(event) or None,
            "query": query,
            "limit": int(self._cfg("recall_limit", 3)),
            "reinforce": True,
        }
        tasks: list[asyncio.Task] = [asyncio.ensure_future(self._call("recall", payload))]
        profile_task = None
        if bool(self._cfg("inject_profile", True)) and self._user(event):
            profile_task = asyncio.ensure_future(
                self._call(
                    "profile",
                    {
                        "subaction": "get",
                        "platform": self._platform(event),
                        "user_id": self._user(event),
                    },
                )
            )
            tasks.append(profile_task)
        results = await asyncio.gather(*tasks, return_exceptions=True)
        recall = results[0]
        profile = results[1] if profile_task is not None else None
        if isinstance(recall, Exception):
            self._warn(f"recall failed: {recall}")
            return
        if isinstance(profile, Exception):
            profile = None
        block = self._format_block(recall, profile)
        if block:
            req.system_prompt = ((req.system_prompt or "").rstrip() + "\n\n" + block).strip()

    @filter.command("memory")
    async def memory_command(self, event: AstrMessageEvent):
        """查看/操作仿生记忆：/memory [status|recall 文本|consolidate|profile]"""
        text = (event.message_str or "").strip()
        parts = text.split()
        if parts and parts[0].lstrip("/#").lower() in {"memory", "记忆"}:
            parts = parts[1:]
        sub = parts[0].lower() if parts else "help"
        try:
            if sub == "status":
                health = await self._call("health")
                stats = health.get("stats", {})
                yield event.plain_result(
                    "仿生记忆引擎\n"
                    f"卡片 {stats.get('notes', 0)}｜画像 {stats.get('profiles', 0)}｜"
                    f"待整合 {stats.get('pendingEvents', 0)}｜归档 {stats.get('archived', 0)}\n"
                    f"桥接 {self._base_url()}"
                )
                return
            if sub == "recall":
                query = " ".join(parts[1:]).strip()
                if not query:
                    yield event.plain_result("用法：/memory recall 一段话")
                    return
                result = await self._call(
                    "recall",
                    {
                        "platform": self._platform(event),
                        "scope_id": self._scope(event),
                        "user_id": self._user(event) or None,
                        "query": query,
                        "limit": 3,
                        "reinforce": False,
                    },
                )
                items = result.get("items") or []
                if not items:
                    yield event.plain_result("没有唤醒任何记忆。")
                    return
                lines = ["假装想起了这些："]
                lines.extend(f"- {item.get('content', '').strip()}" for item in items[:3])
                yield event.plain_result("\n".join(lines))
                return
            if sub == "consolidate":
                result = await self._call(
                    "consolidate",
                    {
                        "mode": "auto",
                        "platform": self._platform(event),
                        "scope_id": self._scope(event),
                    },
                )
                created = result.get("created") or []
                yield event.plain_result(f"睡眠整合完成：新增 {len(created)} 张记忆卡片。")
                return
            if sub == "profile":
                result = await self._call(
                    "profile",
                    {
                        "subaction": "get",
                        "platform": self._platform(event),
                        "user_id": self._user(event),
                    },
                )
                profile = result.get("profile")
                if not profile:
                    yield event.plain_result("还没有你的画像。")
                    return
                facts = profile.get("activeFacts") or {}
                fact_text = "；".join(f"{key}: {value}" for key, value in facts.items()) or "（无）"
                yield event.plain_result(
                    f"{profile.get('nickname')}｜外号 {profile.get('botNicknameForUser') or '（无）'}"
                    f"｜{profile.get('relationshipStage')}｜好感度 {profile.get('affectionScore')}\n"
                    f"近况：{fact_text}"
                )
                return
        except Exception as error:  # noqa: BLE001 - command errors are user-facing
            yield event.plain_result(f"记忆服务暂时不可用：{error}")
            return
        yield event.plain_result(
            "用法：\n"
            "/memory status — 引擎状态\n"
            "/memory recall 文本 — 手动试算唤醒\n"
            "/memory consolidate — 立即整理当前群/私聊\n"
            "/memory profile — 查看自己的画像"
        )

    # ------------------------------------------------------------- formatting
    def _format_block(self, recall: dict, profile: dict | None) -> str:
        items = (recall or {}).get("items") or []
        if not items and not profile:
            return ""
        lines = [
            "### 鱼塘长期记忆闪回",
            "下面是你记得的旧事和眼前这个人。只在话题契合时像老朋友一样自然接梗或调侃，",
            "不要逐字复述原文，也不要提到记忆、检索、分数或这个提示块。",
        ]
        for item in items[: int(self._cfg("recall_limit", 3))]:
            content = str(item.get("content") or "").strip()
            if content:
                lines.append(f"- {content}")
        profile_data = (profile or {}).get("profile") if profile else None
        if profile_data:
            nickname = profile_data.get("nickname") or "这位群友"
            alias = profile_data.get("botNicknameForUser")
            stage = profile_data.get("relationshipStage") or ""
            affection = profile_data.get("affectionScore")
            facts = profile_data.get("activeFacts") or {}
            line = f"### 眼前的熟人：{nickname}"
            if alias:
                line += f"（你私下叫 TA「{alias}」）"
            details = []
            if stage:
                details.append(f"关系 {stage}")
            if affection is not None:
                details.append(f"好感度 {round(float(affection))}/100")
            if details:
                line += "｜" + "｜".join(details)
            lines.append(line)
            if facts:
                lines.append("已知近况：" + "；".join(f"{k}: {v}" for k, v in facts.items()))
        return "\n".join(lines)

    # --------------------------------------------------------------- helpers
    def _platform(self, event: AstrMessageEvent) -> str:
        return str(self._cfg("platform", "qq") or "qq")

    def _scope(self, event: AstrMessageEvent) -> str:
        group_id = str(event.get_group_id() or "").strip()
        if group_id:
            return f"group_{group_id}"
        user = self._user(event) or str(event.get_session_id() or "unknown")
        return f"private_{user}"

    def _user(self, event: AstrMessageEvent) -> str:
        return str(event.get_sender_id() or "").strip()

    def _platform_allowed(self, event: AstrMessageEvent) -> bool:
        allowed = self._cfg("platform_allowlist", ["aiocqhttp"])
        if not allowed:
            return True
        try:
            names = {str(name) for name in allowed}
        except TypeError:
            return True
        return event.get_platform_name() in names

    async def _ingest(self, event: AstrMessageEvent, content: str) -> None:
        payload = {
            "platform": self._platform(event),
            "scope_id": self._scope(event),
            "user_id": self._user(event) or None,
            "nickname": event.get_sender_name() or None,
            "content": content,
        }
        try:
            result = await self._call("ingest", payload)
        except Exception as error:  # noqa: BLE001 - ingestion is best effort
            self._warn(f"ingest failed: {error}")
            return
        scope = payload["scope_id"]
        if result.get("admitted"):
            self._pending[scope] = self._pending.get(scope, 0) + 1
            threshold = int(self._cfg("consolidate_threshold", 0) or 0)
            if threshold > 0 and self._pending[scope] >= threshold:
                self._pending[scope] = 0
                self._spawn(self._consolidate_scope(scope, payload["platform"]))

    async def _consolidate_scope(self, scope: str, platform: str) -> None:
        try:
            await self._call(
                "consolidate",
                {"mode": "auto", "platform": platform, "scope_id": scope},
                timeout=max(self._timeout(), 30.0),
            )
        except Exception as error:  # noqa: BLE001
            self._warn(f"consolidate failed: {error}")

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)

    def _on_task_done(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error is not None:
            self._warn(f"background task failed: {error}")

    def _warn(self, message: str) -> None:
        now = time.monotonic()
        if now - self._last_warning < 60:
            return
        self._last_warning = now
        logger.warning("biomimetic memory: %s", message)

    async def terminate(self) -> None:
        """Cancel background work and stop a bridge this plugin started."""
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()
        if self._session is not None and not self._session.closed:
            await self._session.close()
            self._session = None
        if self._bridge_process is not None and self._bridge_process.returncode is None:
            self._bridge_process.terminate()
            try:
                await asyncio.wait_for(self._bridge_process.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._bridge_process.kill()
            self._bridge_process = None
