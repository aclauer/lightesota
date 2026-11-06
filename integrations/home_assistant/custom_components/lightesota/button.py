"""Non-restorable arm action, safe stops, manual takeover and wash release."""
from homeassistant.components.button import ButtonEntity
from .api import DOMAIN
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    coordinator = hass.data[DOMAIN]
    async_add_entities([
        Action(coordinator, "stop", "Lightesota Stop Lighting All Off", {"type": "stopLighting"}),
        Action(coordinator, "lasers_off", "Lightesota All Lasers Off Disarm", {"type": "lasersOff"}),
        *([LaserArm(coordinator)] if coordinator.client.has_operator else []),
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
        if self.command["type"] in ("stopLighting", "lasersOff"):
            return self.coordinator.last_update_success and self.coordinator.client.online
        return super().available

    async def async_press(self):
        await self.execute(self.command)


class LaserArm(LightesotaEntity, ButtonEntity):
    """A press is never part of scene state reproduction or startup restoration."""
    _attr_icon = "mdi:shield-lock"

    def __init__(self, coordinator):
        super().__init__(coordinator, "laser_arm", "Lightesota Operator Laser Arm")

    async def async_get_last_state(self):
        # Even the native button last-pressed timestamp is deliberately not restored.
        return None

    async def async_press(self):
        await self.require_operator(direct=True)
        await self.execute({"type": "armLasers", "armed": True}, operator=True)
