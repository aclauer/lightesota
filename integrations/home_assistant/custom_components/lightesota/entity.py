"""Shared availability and command plumbing."""
from homeassistant.helpers.update_coordinator import CoordinatorEntity
from homeassistant.exceptions import HomeAssistantError
from .api import DOMAIN


class LightesotaEntity(CoordinatorEntity):
    _attr_has_entity_name = False

    def __init__(self, coordinator, key, name, fixture_id=None):
        super().__init__(coordinator)
        self._attr_unique_id = f"{DOMAIN}_{key}"
        self._attr_name = name
        self.fixture_id = fixture_id

    @property
    def state_data(self):
        return self.coordinator.data or {}

    @property
    def available(self):
        data = self.state_data
        if not self.coordinator.last_update_success or not self.coordinator.client.online or not data.get("available"):
            return False
        if self.fixture_id:
            return any(f["id"] == self.fixture_id and f["enabled"] for f in data.get("rig", {}).get("fixtures", []))
        return True

    @property
    def extra_state_attributes(self):
        return {"control_generation": self.state_data.get("generation"),
                "physical_state": "unverified", "output_authority": "lightesota"}

    async def execute(self, command, *, operator=False):
        await self.coordinator.execute(command, operator=operator, context=self._context)

    async def require_operator(self, *, direct=False):
        context = self._context
        user_id = context.user_id if context else None
        user = await self.hass.auth.async_get_user(user_id) if user_id else None
        if user is None or not user.is_admin or (direct and context.parent_id is not None):
            raise HomeAssistantError("Laser control requires an explicit action by a Home Assistant administrator")
