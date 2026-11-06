"""Per-wash microphone sensitivity and bounded laser pan."""
from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.exceptions import HomeAssistantError
from .api import DOMAIN
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    coordinator = hass.data[DOMAIN]
    async_add_entities([
        *(Sensitivity(coordinator, fixture_id, index + 1) for index, fixture_id in enumerate(coordinator.cfg["wash_fixtures"])),
        *(Pan(coordinator, fixture_id, index + 1) for index, fixture_id in enumerate(coordinator.cfg["laser_fixtures"])),
    ])


class Sensitivity(LightesotaEntity, NumberEntity):
    _attr_native_min_value = 11
    _attr_native_max_value = 255
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator, fixture_id, index):
        super().__init__(coordinator, f"{fixture_id}_sensitivity", f"Office DMX W{index} Mic Sensitivity", fixture_id)

    @property
    def native_value(self):
        return self.state_data.get("washes", {}).get(self.fixture_id, {}).get("sensitivity")

    async def async_set_native_value(self, value):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 11 <= value <= 255 or int(value) != value:
            raise HomeAssistantError("Wash microphone sensitivity must be an integer from 11 to 255")
        await self.execute({"type": "setWash", "fixtureIds": [self.fixture_id], "patch": {"sensitivity": int(value)}})


class Pan(LightesotaEntity, NumberEntity):
    _attr_native_min_value = 48
    _attr_native_max_value = 80
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator, fixture_id, index):
        super().__init__(coordinator, f"{fixture_id}_pan", f"Office Laser {index} Pan", fixture_id)

    @property
    def available(self):
        return super().available and self.coordinator.client.has_operator

    @property
    def native_value(self):
        return self.state_data.get("lasers", {}).get("fixtures", {}).get(self.fixture_id, {}).get("pan")

    async def async_set_native_value(self, value):
        await self.require_operator()
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 48 <= value <= 80 or int(value) != value:
            raise HomeAssistantError("Laser pan must be an integer from 48 to 80")
        await self.execute({"type": "setLaser", "fixtureId": self.fixture_id, "state": {"pan": int(value)}}, operator=True)
