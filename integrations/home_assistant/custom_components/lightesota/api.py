"""Small, dependency-free machine API contract. No DMX or device transport exists here."""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

DOMAIN = "lightesota"
WASH_EFFECTS = {"Normal": "normal", "Music6": "music6", "Music32": "music32"}
COLORS = ("red", "green", "blue", "yellow", "magenta", "cyan")
LASER_EFFECTS = tuple(f"{pattern} {color}" for pattern in ("Fan", "Wave") for color in COLORS) + tuple(f"Music {color}" for color in ("multicolor", *COLORS))
Transport = Callable[[str, str, dict | None, str], Awaitable[tuple[int, Any]]]


class ApiError(Exception):
    """Safe to show to users; never includes headers, raw response bodies or tokens."""


class StaleCommand(ApiError):
    """Caller must make a new deliberate action; this intent must never be replayed."""


def _integer(value: Any, low: int, high: int) -> bool:
    return type(value) is int and low <= value <= high


def parse_state(value: Any) -> dict:
    """Reject partial/malformed snapshots instead of inventing working fixture state."""
    if not isinstance(value, dict):
        raise ApiError("Invalid Lightesota state")
    if not _integer(value.get("generation"), 0, 2**53 - 1) or not _integer(value.get("controlledAt"), 0, 2**53 - 1):
        raise ApiError("Invalid Lightesota control generation")
    if any(type(value.get(key)) is not bool for key in ("available", "blackout", "stopped")):
        raise ApiError("Invalid Lightesota availability")
    ownership = value.get("ownership")
    if not isinstance(ownership, dict) or ownership.get("authority") != DOMAIN or ownership.get("physicalState") != "unverified" or ownership.get("status") not in ("preview", "uncommissioned", "released", "commanding"):
        raise ApiError("Invalid Lightesota output authority")
    rig = value.get("rig")
    if not isinstance(rig, dict) or not isinstance(rig.get("fixtures"), list):
        raise ApiError("Invalid Lightesota rig")
    ids = set()
    for fixture in rig["fixtures"]:
        if not isinstance(fixture, dict) or not isinstance(fixture.get("id"), str) or type(fixture.get("enabled")) is not bool or fixture["id"] in ids:
            raise ApiError("Invalid Lightesota fixture")
        ids.add(fixture["id"])
    washes = value.get("washes")
    if not isinstance(washes, dict):
        raise ApiError("Invalid Lightesota washes")
    for key, wash in washes.items():
        if key not in ids or not isinstance(wash, dict) or wash.get("mode") not in ("off", "normal", "music6", "music32"):
            raise ApiError("Invalid Lightesota wash mode")
        rgbw = wash.get("rgbw")
        if not _integer(wash.get("brightness"), 0, 255) or not _integer(wash.get("sensitivity"), 11, 255) or not isinstance(rgbw, list) or len(rgbw) != 4 or not all(_integer(v, 0, 255) for v in rgbw):
            raise ApiError("Invalid Lightesota wash values")
        if "commandedBrightness" in wash and not _integer(wash["commandedBrightness"], 0, 255):
            raise ApiError("Invalid Lightesota commanded brightness")
    lasers = value.get("lasers")
    if not isinstance(lasers, dict) or type(lasers.get("armed")) is not bool or not isinstance(lasers.get("fixtures"), dict):
        raise ApiError("Invalid Lightesota lasers")
    for key, laser in lasers["fixtures"].items():
        if key not in ids or not isinstance(laser, dict) or laser.get("mode") not in ("off", "manual", "music") or laser.get("pattern") not in ("fan", "wave") or laser.get("color") not in COLORS or laser.get("musicColor") not in ("multicolor", *COLORS) or not _integer(laser.get("pan"), 48, 80):
            raise ApiError("Invalid Lightesota laser preset")
    return value


def wash_on_patch(current: dict, *, brightness=None, rgbw_color=None, effect=None) -> dict:
    patch = {}
    if brightness is not None:
        if not _integer(brightness, 0, 255):
            raise ApiError("Brightness must be an integer from 0 to 255")
        patch["brightness"] = brightness
    if effect is not None:
        if effect not in WASH_EFFECTS:
            raise ApiError("Choose Normal, Music6 or Music32")
        patch["mode"] = WASH_EFFECTS[effect]
    if rgbw_color is not None:
        if not isinstance(rgbw_color, (list, tuple)) or len(rgbw_color) != 4 or not all(_integer(v, 0, 255) for v in rgbw_color):
            raise ApiError("RGBW requires four bytes")
        patch.update(rgbw=list(rgbw_color), mode="normal")
    if current.get("mode") == "off":
        patch.setdefault("mode", "normal")
        if brightness is None:
            patch["brightness"] = current.get("brightness") or 25
    return patch


def laser_effect_state(effect) -> dict:
    if effect not in LASER_EFFECTS:
        raise ApiError("Choose an explicit laser preset after operator arming; generic On cannot start lasers")
    kind, color = effect.split(" ", 1)
    if kind == "Music":
        return {"mode": "music", "musicColor": color}
    return {"mode": "manual", "pattern": kind.lower(), "color": color, "pan": 64}


def context_timestamp(context_id: str | None) -> int | None:
    """HA Context IDs are ULIDs; the first 48 bits encode their creation time in ms."""
    alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    if not isinstance(context_id, str) or len(context_id) != 26:
        return None
    try:
        value = 0
        for char in context_id[:10].upper():
            value = value * 32 + alphabet.index(char)
        return value if value < 2**48 else None
    except ValueError:
        return None


class Client:
    def __init__(self, transport: Transport, token: str, operator_token: str | None = None):
        self.transport = transport
        self._token = token
        self._operator_token = operator_token
        self.state: dict | None = None
        self.online = False
        self.lock = asyncio.Lock()
        # Native HA multi-target services dispatch one entity method per fixture using
        # the SAME Context. Continue only our own acknowledged chain of that intent.
        self._continuation: tuple[str, int] | None = None

    @property
    def has_operator(self):
        return bool(self._operator_token)

    async def _request(self, method, path, body=None, *, operator=False):
        token = self._operator_token if operator else self._token
        if not token:
            raise ApiError("An operator token is required for laser controls")
        try:
            return await self.transport(method, path, body, token)
        except asyncio.CancelledError:
            raise
        except Exception:
            self.online = False
            self._continuation = None
            raise ApiError("Lightesota unavailable; no command was retried") from None

    async def refresh(self) -> dict:
        async with self.lock:
            return await self._refresh()

    async def _refresh(self) -> dict:
        status, data = await self._request("GET", "/api/control/state")
        if status != 200:
            self.online = False
            raise ApiError(f"Lightesota state request failed (HTTP {status})")
        try:
            fresh = parse_state(data)
            if self.state is None or fresh["generation"] != self.state["generation"]:
                self._continuation = None
            self.state = fresh
        except ApiError:
            self.online = False
            raise
        self.online = True
        return self.state

    async def command(self, command: dict, *, operator=False, context_id=None) -> dict:
        if self.state is None or not self.online:
            raise ApiError("Lightesota unavailable; wait for a fresh state before trying again")
        generation = self.state["generation"]  # Capture BEFORE any wait: Stop invalidates queued work.
        created_at = context_timestamp(context_id)
        safe_stop = command.get("type") in ("stopLighting", "lasersOff")
        continues = context_id is not None and self._continuation == (context_id, generation)
        if not safe_stop and not continues and created_at is not None and created_at <= self.state["controlledAt"]:
            raise StaleCommand("Action predates Stop/manual takeover; issue a new action")
        async with self.lock:
            if self.state["generation"] != generation:
                if safe_stop or (context_id is not None and self._continuation == (context_id, self.state["generation"])):
                    generation = self.state["generation"]
                else:
                    raise StaleCommand("Control changed while the action was queued; issue a new action")
            status, data = await self._request("POST", "/api/control/command", {"generation": generation, "command": command}, operator=operator)
            if status == 409:
                self._continuation = None
                try:
                    await self._refresh()
                except ApiError:
                    pass
                raise StaleCommand("Control changed; refreshed state without replaying the action")
            if status != 200:
                self._continuation = None
                if status in (401, 403, 502, 503, 504):
                    self.online = False
                raise ApiError(f"Lightesota command rejected (HTTP {status}); no retry")
            try:
                self.state = parse_state(data)
            except ApiError:
                self.online = False
                self._continuation = None
                raise
            self._continuation = (context_id, self.state["generation"]) if context_id and command.get("type") in ("setWash", "setLaser", "quickLook") else None
            self.online = True
            return self.state
