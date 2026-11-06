"""Control/ownership status is not a physical lamp feedback sensor."""
from homeassistant.components.sensor import SensorEntity
from .api import DOMAIN
from .entity import LightesotaEntity


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    async_add_entities([ControlStatus(hass.data[DOMAIN])])


class ControlStatus(LightesotaEntity, SensorEntity):
    _attr_icon = "mdi:lan-connect"

    def __init__(self, coordinator):
        super().__init__(coordinator, "control_status", "Lightesota Control Status")

    @property
    def available(self):
        return self.coordinator.last_update_success and self.coordinator.client.online

    @property
    def native_value(self):
        return self.state_data.get("ownership", {}).get("status", "unavailable")

    @property
    def extra_state_attributes(self):
        return {**super().extra_state_attributes, "ownership": self.state_data.get("ownership"),
                "stopped": self.state_data.get("stopped"), "blackout": self.state_data.get("blackout"),
                "coordinated_show": self.state_data.get("coordinatedShow"),
                "control_boundary_ms": self.state_data.get("controlledAt")}
