"""Four washes and two guarded preset lights. All mutations use the shared server command path."""
from homeassistant.components.light import (
    ATTR_BRIGHTNESS, ATTR_EFFECT, ATTR_RGBW_COLOR, ColorMode, LightEntity, LightEntityFeature,
)
from homeassistant.exceptions import HomeAssistantError
from .api import ApiError, DOMAIN, LASER_EFFECTS, WASH_EFFECTS, laser_effect_state, wash_on_patch
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    coordinator = hass.data[DOMAIN]
    async_add_entities([
        *(Wash(coordinator, fixture_id, index + 1) for index, fixture_id in enumerate(coordinator.cfg["wash_fixtures"])),
        *(Laser(coordinator, fixture_id, index + 1) for index, fixture_id in enumerate(coordinator.cfg["laser_fixtures"])),
    ])


class Wash(LightesotaEntity, LightEntity):
    _attr_supported_color_modes = {ColorMode.RGBW}
    _attr_color_mode = ColorMode.RGBW
    _attr_supported_features = LightEntityFeature.EFFECT
    _attr_effect_list = list(WASH_EFFECTS)

    def __init__(self, coordinator, fixture_id, index):
        super().__init__(coordinator, fixture_id, f"Office DMX W{index}", fixture_id)

    @property
    def wash(self):
        return self.state_data.get("washes", {}).get(self.fixture_id, {})

    @property
    def available(self):
        return super().available and bool(self.wash)

    @property
    def is_on(self):
        return self.wash.get("mode", "off") != "off" and self.wash.get("commandedBrightness", self.wash.get("brightness", 0)) > 0 and not self.state_data.get("blackout", True)

    @property
    def brightness(self):
        return self.wash.get("brightness", 0)

    @property
    def rgbw_color(self):
        return tuple(self.wash.get("rgbw", [0, 0, 255, 0]))

    @property
    def effect(self):
        return next((label for label, mode in WASH_EFFECTS.items() if mode == self.wash.get("mode")), None)

    @property
    def extra_state_attributes(self):
        return {**super().extra_state_attributes, "commanded_mode": self.wash.get("mode"),
                "source": "Fixture microphone" if self.wash.get("mode") in ("music6", "music32") else "Manual / shared pattern",
                "owner": self.wash.get("owner"), "commanded_brightness": self.wash.get("commandedBrightness"),
                "mic_sensitivity": self.wash.get("sensitivity")}

    async def async_turn_on(self, **kwargs):
        try:
            patch = wash_on_patch(self.wash, brightness=kwargs.get(ATTR_BRIGHTNESS),
                                  rgbw_color=kwargs.get(ATTR_RGBW_COLOR), effect=kwargs.get(ATTR_EFFECT))
        except ApiError as error:
            raise HomeAssistantError(str(error)) from None
        await self.execute({"type": "setWash", "fixtureIds": [self.fixture_id], "patch": patch})

    async def async_turn_off(self, **kwargs):
        await self.execute({"type": "setWash", "fixtureIds": [self.fixture_id], "patch": {"mode": "off"}})


class Laser(LightesotaEntity, LightEntity):
    _attr_supported_color_modes = {ColorMode.ONOFF}
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_features = LightEntityFeature.EFFECT
    _attr_effect_list = list(LASER_EFFECTS)

    def __init__(self, coordinator, fixture_id, index):
        super().__init__(coordinator, fixture_id, f"Office Laser {index} Preset", fixture_id)

    @property
    def laser(self):
        return self.state_data.get("lasers", {}).get("fixtures", {}).get(self.fixture_id, {})

    @property
    def available(self):
        return super().available and bool(self.laser) and self.coordinator.client.has_operator

    @property
    def is_on(self):
        return self.state_data.get("lasers", {}).get("armed", False) and self.laser.get("mode", "off") != "off" and not self.state_data.get("blackout", True)

    @property
    def effect(self):
        if self.laser.get("mode") == "music":
            return f"Music {self.laser['musicColor']}"
        if self.laser.get("mode") == "manual":
            return f"{self.laser['pattern'].title()} {self.laser['color']}"
        return None

    @property
    def extra_state_attributes(self):
        return {**super().extra_state_attributes, "commanded_mode": self.laser.get("mode"),
                "armed": self.state_data.get("lasers", {}).get("armed", False),
                "physical_sensitivity": "S5 at fixture; not DMX configurable"}

    async def async_turn_on(self, **kwargs):
        await self.require_operator()
        if not self.state_data.get("lasers", {}).get("armed"):
            raise HomeAssistantError("An operator must arm lasers first, then select a new explicit preset")
        try:
            preset = laser_effect_state(kwargs.get(ATTR_EFFECT))
        except ApiError as error:
            raise HomeAssistantError(str(error)) from None
        await self.execute({"type": "setLaser", "fixtureId": self.fixture_id, "state": preset}, operator=True)

    async def async_turn_off(self, **kwargs):
        await self.execute({"type": "setLaser", "fixtureId": self.fixture_id, "state": {"mode": "off"}}, operator=True)
