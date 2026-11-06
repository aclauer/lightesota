"""Contract tests with an in-memory HTTP transport; no HA or sockets required."""
import asyncio
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1] / "custom_components" / "lightesota"))
from api import (ApiError, Client, StaleCommand, parse_state, wash_on_patch,
                 laser_effect_state, context_timestamp, validate_origin)


def state(generation=100):
    return {
        "generation": generation, "controlledAt": 1, "available": True,
        "ownership": {"authority": "lightesota", "status": "commanding", "physicalState": "unverified", "legacySenderRetired": False},
        "blackout": False, "stopped": False,
        "rig": {"fixtures": [{"id": "w1", "enabled": True}, {"id": "l1", "enabled": True}]},
        "washes": {"w1": {"mode": "music6", "brightness": 38, "rgbw": [0, 0, 255, 0], "sensitivity": 255}},
        "lasers": {"armed": False, "fixtures": {"l1": {"mode": "off", "pattern": "fan", "color": "cyan", "pan": 64, "musicColor": "multicolor"}}},
    }


class ContractTests(unittest.TestCase):
    def test_origin_rejects_invalid_ports_and_non_origins(self):
        for valid in ("https://lightesota.invalid", "http://127.0.0.1:8787", "https://[::1]:443"):
            self.assertEqual(validate_origin(valid + "/"), valid)
        for bad in ("https://lightesota.invalid:notaport", "https://lightesota.invalid:65536",
                    "https://lightesota.invalid:-1", "https://lightesota.invalid:0",
                    "http://[::1", "ftp://lightesota.invalid", "https://lightesota.invalid/path",
                    "https://user:synthetic@lightesota.invalid", "https://lightesota.invalid?x=1",
                    "https://lightesota.invalid#fragment", "", None):
            with self.subTest(origin=bad), self.assertRaises(ApiError):
                validate_origin(bad)

    def test_brightness_keeps_music_and_color_returns_normal(self):
        wash = state()["washes"]["w1"]
        self.assertEqual(wash_on_patch(wash, brightness=25), {"brightness": 25})
        self.assertEqual(wash_on_patch(wash, rgbw_color=(1, 2, 3, 4)), {"rgbw": [1, 2, 3, 4], "mode": "normal"})
        self.assertEqual(wash_on_patch({**wash, "mode": "off", "brightness": 0}), {"mode": "normal", "brightness": 25})
        self.assertEqual(wash_on_patch(wash, effect="Music32"), {"mode": "music32"})

    def test_invalid_state_is_not_published_as_available(self):
        for key, value in [("generation", float("nan")), ("available", "yes"), ("controlledAt", -1)]:
            candidate = state(); candidate[key] = value
            with self.assertRaises(ApiError): parse_state(candidate)
        candidate = state(); candidate["washes"]["w1"]["sensitivity"] = 10
        with self.assertRaises(ApiError): parse_state(candidate)
        candidate = state(); candidate["washes"]["w1"]["brightness"] = True
        with self.assertRaises(ApiError): parse_state(candidate)
        candidate = state(); candidate["lasers"]["fixtures"]["l1"]["pan"] = 81
        with self.assertRaises(ApiError): parse_state(candidate)
        candidate = state(); candidate["available"] = False
        self.assertFalse(parse_state(candidate)["available"])

    def test_laser_requires_named_preset_and_keeps_geometry(self):
        self.assertEqual(laser_effect_state("Fan cyan"), {"mode": "manual", "pattern": "fan", "color": "cyan", "pan": 64})
        self.assertEqual(laser_effect_state("Music multicolor"), {"mode": "music", "musicColor": "multicolor"})
        for bad in [None, "", "raw 255", "Fan white"]:
            with self.assertRaises(ApiError): laser_effect_state(bad)

    def test_ulid_context_age_is_decoded_without_ha_dependency(self):
        self.assertEqual(context_timestamp("00000000010000000000000000"), 1)
        self.assertIsNone(context_timestamp(None))
        self.assertIsNone(context_timestamp("invalid"))


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_bearer_transport_generation_and_stop_no_retry(self):
        calls = []
        async def transport(method, path, body, token):
            calls.append((method, path, body, token))
            return 200, state(101 if method == "POST" else 100)
        client = Client(transport, "synthetic-guest", "synthetic-operator")
        await client.refresh()
        await client.command({"type": "setWash", "fixtureIds": ["w1"], "patch": {"mode": "normal"}})
        self.assertEqual(calls[-1][2]["generation"], 100)
        self.assertEqual(calls[-1][3], "synthetic-guest")
        self.assertEqual(client.state["generation"], 101)
        await client.command({"type": "armLasers", "armed": True}, operator=True)
        self.assertEqual(calls[-1][3], "synthetic-operator")

    async def test_stale_409_refreshes_without_replaying(self):
        calls = []
        async def transport(method, path, body, token):
            calls.append(method)
            return (409, {"error": "stale"}) if method == "POST" else (200, state(102))
        client = Client(transport, "synthetic")
        client.state = state(); client.online = True
        with self.assertRaises(StaleCommand): await client.command({"type": "stopLighting"})
        self.assertEqual(calls, ["POST", "GET"])
        self.assertEqual(client.state["generation"], 102)

    async def test_queued_command_uses_generation_before_wait_and_context_barrier(self):
        sent = []
        async def transport(method, path, body, token):
            sent.append(body)
            return 200, state(101)
        client = Client(transport, "synthetic"); client.state = state(); client.online = True
        await client.lock.acquire()
        queued = asyncio.create_task(client.command({"type": "setWash", "fixtureIds": ["w1"], "patch": {"mode": "normal"}}))
        await asyncio.sleep(0)
        client.state = state(101)
        client.lock.release()
        with self.assertRaises(StaleCommand): await queued
        self.assertEqual(sent, [])
        client.state["controlledAt"] = 5
        with self.assertRaises(StaleCommand): await client.command({"type": "setWash"}, context_id="00000000010000000000000000")
        self.assertEqual(sent, [])

    async def test_failure_marks_offline_and_errors_omit_secrets(self):
        async def transport(method, path, body, token):
            raise OSError("synthetic-secret-internal")
        client = Client(transport, "synthetic-secret-internal"); client.state = state()
        with self.assertRaisesRegex(ApiError, "unavailable") as error: await client.refresh()
        self.assertNotIn("synthetic-secret", str(error.exception))
        self.assertFalse(client.online)
        with self.assertRaises(ApiError): await client.command({"type": "armLasers", "armed": True}, operator=True)

    async def test_native_multitarget_context_continues_own_changes_but_stop_breaks_chain(self):
        calls = []
        async def transport(method, path, body, token):
            calls.append(body)
            await asyncio.sleep(0)
            fresh = state(100 + len(calls)); fresh["controlledAt"] = 2000
            return 200, fresh
        client = Client(transport, "synthetic"); client.state = state(); client.online = True
        context = "00000000ZZ0000000000000000"
        # All fixture calls share HA's service Context; generation advances each time.
        await asyncio.gather(*(client.command({"type": "setWash", "fixtureIds": [f"w{i}"], "patch": {"mode": "normal"}}, context_id=context) for i in range(1, 5)))
        self.assertEqual([call["generation"] for call in calls], [100, 101, 102, 103])
        await client.command({"type": "stopLighting"}, context_id=context)
        with self.assertRaises(StaleCommand): await client.command({"type": "setWash"}, context_id=context)
        self.assertEqual(len(calls), 5)


if __name__ == "__main__":
    unittest.main()
