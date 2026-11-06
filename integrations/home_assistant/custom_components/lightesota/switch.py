"""Explicit, human-admin laser arming; automation and generic light On never arm."""
from homeassistant.components.switch import SwitchEntity
from .api import DOMAIN
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    coordinator = hass.data[DOMAIN]
    if coordinator.client.has_operator:
        async_add_entities([LaserArm(coordinator)])


class LaserArm(LightesotaEntity, SwitchEntity):
    _attr_icon = "mdi:shield-lock"

    def __init__(self, coordinator):
        super().__init__(coordinator, "laser_arm", "Lightesota Operator Laser Arm")

    @property
    def is_on(self):
        return self.state_data.get("lasers", {}).get("armed", False)

    async def async_turn_on(self, **kwargs):
        # Dashboard visibility is not authorization. No automation context may arm.
        await self.require_operator(direct=True)
        await self.execute({"type": "armLasers", "armed": True}, operator=True)

    async def async_turn_off(self, **kwargs):
        await self.execute({"type": "lasersOff"})
