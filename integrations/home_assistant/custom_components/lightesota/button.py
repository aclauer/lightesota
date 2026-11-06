"""Common Stop, explicit manual takeover and per-wash release to pattern."""
from homeassistant.components.button import ButtonEntity
from .api import DOMAIN
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    coordinator = hass.data[DOMAIN]
    async_add_entities([
        Action(coordinator, "stop", "Lightesota Stop Lighting All Off", {"type": "stopLighting"}),
        Action(coordinator, "manual", "Lightesota Take Manual Control", {"type": "takeManualControl"}),
        *(Action(coordinator, f"{fixture_id}_release", f"Office DMX W{index + 1} Release To Pattern",
                 {"type": "releaseWashes", "fixtureIds": [fixture_id]})
          for index, fixture_id in enumerate(coordinator.cfg["wash_fixtures"])),
    ])


class Action(LightesotaEntity, ButtonEntity):
    def __init__(self, coordinator, key, name, command):
        super().__init__(coordinator, key, name)
        self.command = command

    @property
    def available(self):
        # Stop remains usable while output is released/uncommissioned, if service reachable.
        if self.command["type"] == "stopLighting":
            return self.coordinator.last_update_success and self.coordinator.client.online
        return super().available

    async def async_press(self):
        await self.execute(self.command)
