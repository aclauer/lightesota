"""Exercise production entity methods with explicit HA doubles, not a fake HA acceptance claim."""
import importlib
import pathlib
import sys
import types
import unittest
from enum import IntFlag, StrEnum
from contextvars import ContextVar
from unittest.mock import AsyncMock

from test_api import state


def module(name, **members):
    item = types.ModuleType(name)
    item.__dict__.update(members)
    sys.modules[name] = item


class HomeAssistantError(Exception):
    pass


class CoordinatorEntity:
    def __init__(self, coordinator):
        self.coordinator = coordinator
        self._context = types.SimpleNamespace(id=None, user_id="admin", parent_id=None)
        self.hass = types.SimpleNamespace(auth=types.SimpleNamespace(async_get_user=AsyncMock(return_value=types.SimpleNamespace(is_admin=True))))


class ColorMode(StrEnum):
    RGBW = "rgbw"
    ONOFF = "onoff"


class LightEntityFeature(IntFlag):
    EFFECT = 4


module("homeassistant")
module("homeassistant.components")
module("homeassistant.helpers")
script_stack: ContextVar[list[str] | None] = ContextVar("script_stack", default=None)
module("homeassistant.helpers.script", script_stack_cv=script_stack)
module("homeassistant.helpers.update_coordinator", CoordinatorEntity=CoordinatorEntity)
module("homeassistant.exceptions", HomeAssistantError=HomeAssistantError)
module("homeassistant.components.light", ATTR_BRIGHTNESS="brightness", ATTR_EFFECT="effect", ATTR_RGBW_COLOR="rgbw_color",
       ColorMode=ColorMode, LightEntity=type("LightEntity", (), {}), LightEntityFeature=LightEntityFeature)
module("homeassistant.components.switch", SwitchEntity=type("SwitchEntity", (), {}))
module("homeassistant.components.number", NumberEntity=type("NumberEntity", (), {}), NumberMode=types.SimpleNamespace(SLIDER="slider"))
module("homeassistant.components.button", ButtonEntity=type("ButtonEntity", (), {}))
module("homeassistant.components.sensor", SensorEntity=type("SensorEntity", (), {}))
package = types.ModuleType("lightesota")
package.__path__ = [str(pathlib.Path(__file__).parents[1] / "custom_components" / "lightesota")]
sys.modules["lightesota"] = package
light = importlib.import_module("lightesota.light")
switch = importlib.import_module("lightesota.switch")
number = importlib.import_module("lightesota.number")
button = importlib.import_module("lightesota.button")
sensor = importlib.import_module("lightesota.sensor")


def coordinator():
    return types.SimpleNamespace(data=state(), last_update_success=True,
                                 client=types.SimpleNamespace(online=True, has_operator=True),
                                 execute=AsyncMock())


class EntityTests(unittest.IsolatedAsyncioTestCase):
    async def test_wash_commands_are_selected_and_brightness_preserves_mode(self):
        c = coordinator(); wash = light.Wash(c, "w1", 1)
        await wash.async_turn_on(brightness=25)
        self.assertEqual(c.execute.call_args.args[0], {"type": "setWash", "fixtureIds": ["w1"], "patch": {"brightness": 25}})
        await wash.async_turn_on(effect="Music32", rgbw_color=(1, 2, 3, 4))
        self.assertEqual(c.execute.call_args.args[0]["patch"]["mode"], "normal")
        await wash.async_turn_off()
        self.assertEqual(c.execute.call_args.args[0]["patch"], {"mode": "off"})

    async def test_laser_explicit_preset_requires_arm_and_operator(self):
        c = coordinator(); laser = light.Laser(c, "l1", 1)
        with self.assertRaises(HomeAssistantError): await laser.async_turn_on(effect="Fan cyan")
        c.data["lasers"]["armed"] = True
        with self.assertRaises(HomeAssistantError): await laser.async_turn_on()
        laser.hass.auth.async_get_user.return_value.is_admin = False
        with self.assertRaises(HomeAssistantError): await laser.async_turn_on(effect="Fan cyan")
        c.execute.assert_not_called()
        laser.hass.auth.async_get_user.return_value.is_admin = True
        await laser.async_turn_on(effect="Fan cyan")
        self.assertEqual(c.execute.call_args.args[0]["state"], {"mode": "manual", "pattern": "fan", "color": "cyan", "pan": 64})
        self.assertTrue(c.execute.call_args.kwargs["operator"])

    async def test_arm_requires_direct_admin_context_disarm_does_not(self):
        c = coordinator(); arm = switch.LaserArm(c)
        arm._context.user_id = None
        with self.assertRaises(HomeAssistantError): await arm.async_turn_on()
        arm._context.user_id = "admin"; arm._context.parent_id = "automation"
        with self.assertRaises(HomeAssistantError): await arm.async_turn_on()
        c.execute.assert_not_called()
        arm._context.parent_id = None
        await arm.async_turn_on()
        self.assertEqual(c.execute.call_args.args[0], {"type": "armLasers", "armed": True})
        arm._context.user_id = None
        await arm.async_turn_off()
        self.assertEqual(c.execute.call_args.args[0], {"type": "lasersOff"})

    async def test_offline_and_preview_never_publish_available_lights(self):
        c = coordinator(); wash = light.Wash(c, "w1", 1)
        self.assertTrue(wash.available)
        c.client.online = False
        self.assertFalse(wash.available)
        c.client.online = True; c.last_update_success = False
        self.assertFalse(wash.available)
        c.last_update_success = True; c.data["available"] = False
        self.assertFalse(wash.available)
        self.assertTrue(sensor.ControlStatus(c).available)
        stop = button.Action(c, "stop", "Stop", {"type": "stopLighting"})
        self.assertTrue(stop.available)
        await stop.async_press()
        self.assertEqual(c.execute.call_args.args[0], {"type": "stopLighting"})

    async def test_script_cannot_arm_with_inherited_root_admin_context(self):
        c = coordinator(); arm = switch.LaserArm(c)
        token = script_stack.set(["script.synthetic_arm"])
        try:
            with self.assertRaises(HomeAssistantError):
                await arm.async_turn_on()
            c.execute.assert_not_called()
            await arm.async_turn_off()
            self.assertEqual(c.execute.call_args.args[0], {"type": "lasersOff"})
        finally:
            script_stack.reset(token)
        c.execute.reset_mock()
        await arm.async_turn_on()
        self.assertEqual(c.execute.call_args.args[0], {"type": "armLasers", "armed": True})

    async def test_sensitivity_and_pan_are_bounded_without_implicit_start(self):
        c = coordinator(); sensitivity = number.Sensitivity(c, "w1", 1); pan = number.Pan(c, "l1", 1)
        for bad in (float("nan"), float("inf"), 10, 256, 12.5, True):
            with self.assertRaises(HomeAssistantError): await sensitivity.async_set_native_value(bad)
        for bad in (47, 81, float("nan")):
            with self.assertRaises(HomeAssistantError): await pan.async_set_native_value(bad)
        c.execute.assert_not_called()
        await sensitivity.async_set_native_value(255)
        self.assertEqual(c.execute.call_args.args[0]["patch"], {"sensitivity": 255})
        await pan.async_set_native_value(64)
        self.assertEqual(c.execute.call_args.args[0]["state"], {"pan": 64})


if __name__ == "__main__":
    unittest.main()
