"""Offline boundary tests: no Hermes profile, network, or lighting hardware."""
import concurrent.futures
import importlib.util
import json
from pathlib import Path
import sys
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / "hermes-plugin"
spec = importlib.util.spec_from_file_location("lightesota_plugin", ROOT / "__init__.py")
assert spec is not None and spec.loader is not None
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)

TEAM = "T01234567"
CHANNEL = "C01234567"
USER = "U01234567"
CONFIG = {
    "LIGHTESOTA_GISKARD_ENABLED": "1",
    "LIGHTESOTA_GISKARD_BASE_URL": "https://lighting.example.test",
    "LIGHTESOTA_GISKARD_TOKEN": "test-only-" + "x" * 40,
    "LIGHTESOTA_GISKARD_TEAM_ID": TEAM,
    "LIGHTESOTA_GISKARD_CHANNEL_ID": CHANNEL,
    "LIGHTESOTA_GISKARD_USER_IDS": USER + ",U07654321",
}
COMMAND = {"kind": "set_lights", "fixtureIds": ["w1"], "brightness": 30}
SESSION = {
    "HERMES_SESSION_PLATFORM": "slack",
    "HERMES_SESSION_CHAT_ID": CHANNEL,
    "HERMES_SESSION_CHAT_TYPE": "group",
    "HERMES_SESSION_USER_ID": USER,
    "HERMES_SESSION_SCOPE_ID": TEAM,
    "HERMES_SESSION_ID": "session-one",
    "HERMES_SESSION_MESSAGE_ID": "1234567890.000001",
    "HERMES_SESSION_PROFILE": "default",
}


class FakeClient:
    def __init__(self):
        self.calls = []
        self.fail_lease = False
    def post(self, path, body):
        self.calls.append((path, body))
        if path == "lease":
            if self.fail_lease:
                raise OSError("secret test-only-token must not escape")
            return {"leaseId": "opaque-lease", "generation": 1}
        return {"ok": True, "physicalOutputVerified": False, "state": {"master": 0}}


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.session = dict(SESSION)
        self.client = FakeClient()
        self.now = 100.0
        self.bridge = plugin.LightingBridge(
            CONFIG, session_env=lambda k, default="": self.session.get(k, default),
            client=self.client, clock=lambda: self.now, claim_event=lambda _: True,
        )
    def begin(self, turn="turn-one"):
        self.bridge.before_llm(turn_id=turn, session_id="session-one", request={})
    def invoke(self, name, args=None, turn="turn-one"):
        return json.loads(self.bridge.around_tool(
            tool_name=name, args=args or {}, turn_id=turn, session_id="session-one",
            next_call=lambda actual: self.bridge.handle(name, actual),
        ))
    def test_direct_handler_fails_closed_without_middleware(self):
        self.begin()
        self.assertFalse(json.loads(self.bridge.handle("lighting_stop", {}))["ok"])
        self.assertEqual([p for p, _ in self.client.calls], ["lease"])
    def test_lease_captured_once_before_inference_and_never_exposed(self):
        self.begin(); self.begin()
        result = self.invoke("lighting_state")
        self.assertTrue(result["ok"])
        self.assertNotIn("opaque-lease", json.dumps(result))
        self.assertEqual([p for p, _ in self.client.calls], ["lease", "state"])
        command = {"kind": "set_lights", "fixtureIds": ["w1"], "brightness": 30}
        self.assertTrue(self.invoke("lighting_apply", {"command": command})["ok"])
        self.assertFalse(self.invoke("lighting_apply", {"command": command})["ok"])
        self.begin()
        self.assertEqual([p for p, _ in self.client.calls].count("lease"), 1)
        sent = self.client.calls[-1][1]
        self.assertEqual(sent["identity"]["userId"], USER)
        self.assertEqual(sent["leaseId"], "opaque-lease")
    def test_replayed_slack_message_keeps_event_id_across_runtime_turns_and_sessions(self):
        self.begin()
        first = self.client.calls[0][1]["identity"]["turnId"]
        self.assertTrue(self.invoke("lighting_apply", {"command": COMMAND})["ok"])
        self.begin("retry-turn")
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND}, "retry-turn")["ok"])
        self.assertEqual([p for p, _ in self.client.calls].count("lease"), 1)
        # Reconstructing the gateway process must still present the SAME Slack event
        # to the server's replay ledger, even with a different Hermes session/turn.
        self.session["HERMES_SESSION_ID"] = "new-session"
        restarted = plugin.LightingBridge(CONFIG, session_env=lambda k, default="": self.session.get(k, default), client=self.client, claim_event=lambda _: True)
        restarted.before_llm(turn_id="new-runtime-turn", session_id="new-session")
        self.assertEqual(self.client.calls[-1][1]["identity"]["turnId"], first)
    def test_stop_does_not_need_lease_and_consumes_local_authority(self):
        self.client.fail_lease = True
        self.begin()
        self.assertTrue(self.invoke("lighting_stop")["ok"])
        self.assertNotIn("secret", json.dumps(self.invoke("lighting_apply", {"command": COMMAND})))
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND})["ok"])
    def test_failed_lease_expiry_and_wrong_turn_cannot_refresh(self):
        self.client.fail_lease = True
        self.begin(); self.client.fail_lease = False; self.begin()
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND})["ok"])
        self.assertEqual(len(self.client.calls), 1)
        self.session["HERMES_SESSION_MESSAGE_ID"] = "1234567890.000002"
        self.begin("turn-two")
        self.assertEqual(len(self.client.calls), 2)
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND}, "unknown-turn")["ok"])
        self.now += 121
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND}, "turn-two")["ok"])
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND}, "unknown-turn")["ok"])
    def test_foreign_identity_dm_cron_missing_metadata_and_disabled_deny(self):
        for field, value in [("HERMES_SESSION_PLATFORM", "api_server"),
                             ("HERMES_SESSION_SCOPE_ID", "T99999999"),
                             ("HERMES_SESSION_CHAT_ID", "C99999999"),
                             ("HERMES_SESSION_USER_ID", "U99999999"),
                             ("HERMES_SESSION_CHAT_TYPE", "dm"),
                             ("HERMES_CRON_SESSION", "1"),
                             ("HERMES_SESSION_MESSAGE_ID", "")]:
            with self.subTest(field=field):
                self.session = {**SESSION, field: value}
                self.begin()
                self.assertFalse(self.invoke("lighting_stop")["ok"])
        self.assertEqual(self.client.calls, [])
        disabled = plugin.LightingBridge({}, session_env=lambda k, default="": SESSION.get(k, default), client=self.client)
        self.assertFalse(json.loads(disabled.handle("lighting_stop", {}))["ok"])
    def test_durable_receipt_blocks_replay_after_gateway_and_backend_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "receipts.db"
            receipts = plugin.EventReceipts(lambda: sqlite3.connect(db))
            first = plugin.LightingBridge(CONFIG, session_env=lambda k, d="": self.session.get(k, d),
                                          client=self.client, claim_event=receipts.claim)
            first.before_llm(session_id="session-one", turn_id="first-runtime")
            self.assertEqual([p for p, _ in self.client.calls], ["lease"])
            # A fresh gateway and fresh backend client retain no in-memory state.
            restarted_client = FakeClient()
            restarted_store = plugin.EventReceipts(lambda: sqlite3.connect(db))
            restarted = plugin.LightingBridge(CONFIG, session_env=lambda k, d="": self.session.get(k, d),
                                              client=restarted_client, claim_event=restarted_store.claim)
            restarted.before_llm(session_id="session-one", turn_id="retry-runtime")
            self.assertEqual(restarted_client.calls, [])
            result = restarted.around_tool(tool_name="lighting_apply", args={"command": COMMAND},
                                           session_id="session-one", turn_id="retry-runtime",
                                           next_call=lambda a: restarted.handle("lighting_apply", a))
            self.assertFalse(json.loads(result)["ok"])
            self.session["HERMES_SESSION_MESSAGE_ID"] = "1234567890.000002"
            restarted.before_llm(session_id="session-one", turn_id="fresh-human-message")
            self.assertEqual([p for p, _ in restarted_client.calls], ["lease"])
    def test_receipt_storage_failure_blocks_apply_but_not_stop(self):
        def broken(_): raise OSError("private filesystem detail")
        self.bridge = plugin.LightingBridge(CONFIG, session_env=lambda k, d="": self.session.get(k, d),
                                            client=self.client, claim_event=broken)
        self.begin()
        self.assertEqual(self.client.calls, [])
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND})["ok"])
        self.assertTrue(self.invoke("lighting_stop")["ok"])
    def test_argument_identity_or_arbitrary_commands_are_not_forwarded(self):
        self.begin()
        self.assertFalse(self.invoke("lighting_state", {"identity": {"userId": "admin"}})["ok"])
        self.assertFalse(self.invoke("lighting_apply", {"command": {"kind": "arm_lasers"}})["ok"])
        self.assertEqual([p for p, _ in self.client.calls], ["lease"])
    def test_context_does_not_leak_after_call_or_into_other_thread(self):
        self.begin()
        def nested(args):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                other = pool.submit(self.bridge.handle, "lighting_stop", {}).result()
            self.assertFalse(json.loads(other)["ok"])
            return self.bridge.handle("lighting_state", args)
        result = self.bridge.around_tool(tool_name="lighting_state", args={}, turn_id="turn-one", session_id="session-one", next_call=nested)
        self.assertTrue(json.loads(result)["ok"])
        self.assertFalse(json.loads(self.bridge.handle("lighting_stop", {}))["ok"])
    def test_wrong_actor_cannot_reuse_turn_and_nonlighting_tools_unchanged(self):
        self.begin()
        self.session["HERMES_SESSION_USER_ID"] = "U07654321"
        self.assertFalse(self.invoke("lighting_apply", {"command": COMMAND})["ok"])
        self.assertEqual(self.bridge.around_tool(tool_name="clarify", args={"x": 1}, next_call=lambda args: args), {"x": 1})
    def test_transport_rejects_unsafe_endpoints_and_redirects(self):
        for url in ["http://10.10.229.6:8787", "https://u:p@example.test", "https://example.test/path", "https://example.test?x=1", "https://example.test:bad"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                plugin.Client(url, CONFIG["LIGHTESOTA_GISKARD_TOKEN"])
        self.assertIsNone(plugin.NoRedirect().redirect_request(None, None, 302, "", {}, "https://elsewhere.test"))
    def test_register_exposes_only_three_narrow_tools_and_two_middlewares(self):
        class Context:
            def __init__(self): self.tools=[]; self.middleware=[]
            def register_tool(self, **kwargs): self.tools.append(kwargs)
            def register_middleware(self, kind, fn): self.middleware.append(kind)
        ctx = Context()
        plugin.register(ctx)
        self.assertEqual({t["name"] for t in ctx.tools}, {"lighting_state", "lighting_apply", "lighting_stop"})
        self.assertEqual(ctx.middleware, ["llm_request", "tool_execution"])
        for t in ctx.tools:
            self.assertNotIn("identity", json.dumps(t["schema"]))
            self.assertNotIn("leaseId", json.dumps(t["schema"]))


if __name__ == "__main__":
    unittest.main()
