"""Narrow, fail-closed Slack lighting tools. No model-controlled identity or URLs."""
from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass
import hashlib
import json
import math
import os
import re
import threading
import time
from typing import Any
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, ProxyHandler, build_opener

TOOLS = ("lighting_state", "lighting_apply", "lighting_stop")
MAX_BODY = 65536


def denied(message="Lighting request refused: trusted Slack context or authorization is unavailable."):
    return json.dumps({"ok": False, "error": message, "physicalOutputVerified": False})


def clean(value):
    """Never expose authorization material through model-visible tool results."""
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()
                if k.lower() not in {"leaseid", "token", "authorization", "secret"}}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Client:
    def __init__(self, base_url, token):
        parsed = urlsplit(base_url)
        port = parsed.port  # Also validates malformed ports.
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment or port == 0
                or not isinstance(token, str) or len(token) < 32
                or any(c.isspace() for c in token)):
            raise ValueError("A fixed HTTPS origin and dedicated token are required")
        self.base_url = base_url.rstrip("/")
        self._token = token
        self._opener = build_opener(ProxyHandler({}), NoRedirect())

    def post(self, path, body):
        if path not in {"state", "lease", "apply", "stop"}:
            raise ValueError("Unsupported lighting route")
        data = json.dumps(body, allow_nan=False).encode()
        if len(data) > MAX_BODY:
            raise ValueError("Lighting request too large")
        request = Request(self.base_url + "/api/integrations/giskard/" + path, data=data,
                          headers={"Authorization": "Bearer " + self._token,
                                   "Content-Type": "application/json"}, method="POST")
        try:
            with self._opener.open(request, timeout=8) as response:
                raw = response.read(MAX_BODY + 1)
                if len(raw) > MAX_BODY:
                    raise ValueError("Lighting response too large")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ValueError("Invalid lighting response")
                return result
        except Exception:
            # Do not include URLs, headers, upstream bodies, or secret-bearing exceptions.
            raise RuntimeError("Lighting service unavailable or request refused") from None


@dataclass(frozen=True)
class Identity:
    teamId: str
    channelId: str
    userId: str
    turnId: str

    def body(self):
        return dict(teamId=self.teamId, channelId=self.channelId,
                    userId=self.userId, turnId=self.turnId)


@dataclass
class Turn:
    lease: str | None
    expires: float
    runtime: tuple[str, str]
    used: bool = False


def session_value(name, default=""):
    from gateway.session_context import get_session_env
    return get_session_env(name, default)


def fresh_slack_message(message, now):
    """Validate trusted Slack event ts, preserving its exact token for the identity hash."""
    if not isinstance(message, str) or re.fullmatch(r"[0-9]{10}\.[0-9]{6}", message) is None:
        return False
    if type(now) not in (int, float) or (type(now) is float and not math.isfinite(now)):
        return False
    timestamp_us = int(message[:10]) * 1_000_000 + int(message[11:])
    # Compare to the exact represented wall time without rounding either boundary.
    numerator, denominator = now.as_integer_ratio()
    age = numerator * 1_000_000 - timestamp_us * denominator
    return -30_000_000 * denominator <= age <= 120_000_000 * denominator


def valid_command(command):
    if not isinstance(command, dict):
        return False
    kind = command.get("kind")
    allowed = {
        "set_lights": {"kind", "fixtureIds", "brightness", "color"},
        "wash_mode": {"kind", "fixtureIds", "mode", "sensitivity"},
        "quick_look": {"kind", "fixtureIds", "lookId"},
    }
    if kind not in allowed or set(command) - allowed[kind]:
        return False
    ids = command.get("fixtureIds")
    if (not isinstance(ids, list) or not 1 <= len(ids) <= 64
            or any(not isinstance(x, str) or not 1 <= len(x) <= 128 for x in ids)
            or len(set(ids)) != len(ids)):
        return False
    if kind == "set_lights":
        n = command.get("brightness")
        return (isinstance(n, (int, float)) and not isinstance(n, bool) and 0 <= n <= 100
                and ("color" not in command or bool(re.fullmatch(r"#[0-9a-fA-F]{6}", str(command["color"])))))
    if kind == "wash_mode":
        n = command.get("sensitivity", 255)
        return command.get("mode") in {"off", "normal", "music6", "music32"} and type(n) is int and 11 <= n <= 255
    return command.get("lookId") in {"warm-arrival", "cyan-magenta", "calm-blue"}


class EventReceipts:
    """Persist only event hashes, before requesting authority; never tokens or leases."""
    def __init__(self, connect):
        self.connect = connect

    def claim(self, event_id):
        db = self.connect()
        try:
            db.execute("CREATE TABLE IF NOT EXISTS lighting_events (event_id TEXT PRIMARY KEY)")
            with db:
                db.execute("BEGIN IMMEDIATE")
                if db.execute("SELECT 1 FROM lighting_events WHERE event_id = ?", (event_id,)).fetchone():
                    return False
                if db.execute("SELECT COUNT(*) FROM lighting_events").fetchone()[0] >= 100000:
                    return False  # Fail closed; never evict replay protection automatically.
                db.execute("INSERT INTO lighting_events (event_id) VALUES (?)", (event_id,))
            return True
        finally:
            db.close()


def persistent_receipt(event_id):
    # Resolve the active profile lazily. Disabled/foreign contexts never create files.
    from plugins.plugin_storage import plugin_db
    return EventReceipts(lambda: plugin_db("lightesota", "events.db")).claim(event_id)


class LightingBridge:
    def __init__(self, config, *, session_env=session_value, client=None, clock=time.monotonic,
                 wall_clock=time.time, claim_event=persistent_receipt):
        self.session_env, self.clock, self.wall_clock = session_env, clock, wall_clock
        self.claim_event = claim_event
        self.enabled = config.get("LIGHTESOTA_GISKARD_ENABLED") == "1"
        self.team = config.get("LIGHTESOTA_GISKARD_TEAM_ID", "")
        self.channel = config.get("LIGHTESOTA_GISKARD_CHANNEL_ID", "")
        self.users = frozenset(x.strip() for x in config.get("LIGHTESOTA_GISKARD_USER_IDS", "").split(",") if x.strip())
        self.enabled = bool(self.enabled and re.fullmatch(r"T[A-Z0-9]+", self.team)
                            and re.fullmatch(r"C[A-Z0-9]+", self.channel) and self.users
                            and all(re.fullmatch(r"[UW][A-Z0-9]+", x) for x in self.users))
        self.client = client
        if self.client is None and self.enabled:
            try:
                self.client = Client(config.get("LIGHTESOTA_GISKARD_BASE_URL", ""),
                                     config.get("LIGHTESOTA_GISKARD_TOKEN", ""))
            except ValueError:
                self.enabled = False
        self._turns: dict[Identity, Turn] = {}
        self._lock = threading.Lock()
        self._context: ContextVar[tuple[Identity, tuple[str, str]] | None] = ContextVar("lightesota_trusted_tool_context", default=None)

    def identity(self, metadata):
        if not self.enabled or self.client is None:
            return None
        get = self.session_env
        if (get("HERMES_SESSION_PLATFORM") != "slack"
                or get("HERMES_CRON_SESSION")
                or get("HERMES_SESSION_CHAT_TYPE") not in {"group", "channel", "thread"}
                or get("HERMES_SESSION_SCOPE_ID") != self.team
                or get("HERMES_SESSION_CHAT_ID") != self.channel
                or get("HERMES_SESSION_USER_ID") not in self.users):
            return None
        session = get("HERMES_SESSION_ID")
        message = get("HERMES_SESSION_MESSAGE_ID")
        turn = metadata.get("turn_id")
        if (not session or not isinstance(turn, str) or not turn
                or metadata.get("session_id") != session
                or not fresh_slack_message(message, self.wall_clock())):
            return None
        # A Slack message is stable across gateway retries/restarts; Hermes session
        # and turn IDs are not. Runtime correlation is checked separately below.
        digest = hashlib.sha256(json.dumps([self.team, self.channel, get("HERMES_SESSION_USER_ID"), message]).encode()).hexdigest()
        return Identity(self.team, self.channel, get("HERMES_SESSION_USER_ID"), digest)

    def before_llm(self, **metadata):
        try:
            identity = self.identity(metadata)
            if identity is None or self.client is None:
                return None
            with self._lock:
                if identity in self._turns:
                    return None
                now = self.clock()
                # Expired entries cannot authorize an old tool. Backend also refuses renewal.
                self._turns = {k: v for k, v in self._turns.items() if v.expires + 600 > now}
                if len(self._turns) >= 2048:
                    return None
                record = Turn(None, now + 120, (metadata["session_id"], metadata["turn_id"]))
                self._turns[identity] = record  # Failure is remembered; retries cannot renew.
            if not self.claim_event(identity.turnId):
                return None
            result = self.client.post("lease", {"identity": identity.body()})
            lease = result.get("leaseId")
            if isinstance(lease, str) and lease and len(lease) <= 256:
                with self._lock:
                    record.lease = lease
        except Exception:
            # Hooks are fail-open in Hermes; handlers below are independently fail-closed.
            pass
        return None  # Do not modify model settings or request kwargs.

    def around_tool(self, **metadata):
        name = metadata.get("tool_name")
        if name not in TOOLS:
            return metadata["next_call"](metadata["args"])
        try:
            identity = self.identity(metadata)
        except Exception:
            return denied()
        if identity is None:
            return denied("Lighting request requires fresh authorized Slack context. Ask again in a new Slack message.")
        token = self._context.set((identity, (metadata["session_id"], metadata["turn_id"])))
        try:
            return metadata["next_call"](metadata["args"])
        finally:
            self._context.reset(token)

    def handle(self, name, args):
        context = self._context.get()
        if context is None or not self.enabled or self.client is None or name not in TOOLS:
            return denied()
        identity, runtime = context
        if not isinstance(args, dict):
            return denied("Invalid lighting arguments")
        route = name.removeprefix("lighting_")
        body: dict[str, Any] = {"identity": identity.body()}
        if route == "apply":
            if set(args) != {"command"} or not valid_command(args["command"]):
                return denied("Only bounded ordinary-light commands are supported")
            with self._lock:
                record = self._turns.get(identity)
                if (record is None or record.runtime != runtime or record.used
                        or record.lease is None or self.clock() >= record.expires):
                    return denied("This turn has no fresh lighting authority. Ask again in a new Slack message.")
                record.used = True  # One attempt, including timeout/unknown outcome; never retry.
                body.update(leaseId=record.lease, command=args["command"])
        elif args:
            return denied("This lighting tool takes no arguments")
        elif route == "stop":
            with self._lock:
                record = self._turns.get(identity)
                if record is not None:
                    record.used = True
        try:
            return json.dumps(clean(self.client.post(route, body)), allow_nan=False)
        except Exception:
            return denied("Lighting service unavailable or request refused; physical output is not verified. Do not retry the same change.")


def register(ctx):
    bridge = LightingBridge(os.environ)
    ctx.register_middleware("llm_request", bridge.before_llm)
    ctx.register_middleware("tool_execution", bridge.around_tool)
    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    ids = {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 64, "uniqueItems": True}
    commands = []
    for kind, fields, required in [
        ("set_lights", {"brightness": {"type": "number", "minimum": 0, "maximum": 100},
                        "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}}, ["brightness"]),
        ("wash_mode", {"mode": {"type": "string", "enum": ["off", "normal", "music6", "music32"]},
                       "sensitivity": {"type": "integer", "minimum": 11, "maximum": 255}}, ["mode"]),
        ("quick_look", {"lookId": {"type": "string", "enum": ["warm-arrival", "cyan-magenta", "calm-blue"]}}, ["lookId"]),
    ]:
        commands.append({"type": "object", "properties": {"kind": {"const": kind}, "fixtureIds": ids, **fields},
                         "required": ["kind", "fixtureIds", *required], "additionalProperties": False})
    specs = [
        ("lighting_state", "Read Lightesota's commanded lighting state and ordinary fixture IDs. This is not physical feedback.", empty),
        ("lighting_apply", "Apply one requested ordinary-light batch this turn. Read state for target IDs. No lasers, haze, strobe, schedules or code. Never retry an uncertain result.",
         {"type": "object", "properties": {"command": {"oneOf": commands}}, "required": ["command"], "additionalProperties": False}),
        ("lighting_stop", "Stop Lightesota output and disarm its effects immediately. No claim about an independent Home Assistant sender or physical feedback.", empty),
    ]
    for name, description, parameters in specs:
        def handler(args, _name=name, **kwargs):
            return bridge.handle(_name, args)
        ctx.register_tool(name=name, toolset="lightesota", description=description,
                          schema={"name": name, "description": description, "parameters": parameters},
                          handler=handler)
