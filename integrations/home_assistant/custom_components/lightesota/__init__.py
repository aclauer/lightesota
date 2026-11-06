"""YAML-configured HA client of Lightesota's single output authority."""
from __future__ import annotations

from datetime import timedelta
import logging

import voluptuous as vol
from homeassistant.const import CONF_TOKEN, CONF_URL
from homeassistant.helpers import config_validation as cv, discovery
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import ApiError, Client, DOMAIN, validate_origin

_LOGGER = logging.getLogger(__name__)


def _url(value):
    try:
        return validate_origin(cv.string(value))
    except ApiError as err:
        raise vol.Invalid(str(err)) from None


CONFIG_SCHEMA = vol.Schema({
    DOMAIN: vol.Schema({
        vol.Required(CONF_URL): _url,
        vol.Required(CONF_TOKEN): cv.string,
        vol.Optional("operator_token"): cv.string,
        vol.Optional("poll_interval", default=2): vol.All(vol.Coerce(int), vol.Range(min=1, max=30)),
        vol.Optional("wash_fixtures", default=["w1", "w2", "w3", "w4"]): vol.All([cv.string], vol.Length(min=4, max=4), vol.Unique()),
        vol.Optional("laser_fixtures", default=["l1", "l2"]): vol.All([cv.string], vol.Length(min=2, max=2), vol.Unique()),
    }),
}, extra=vol.ALLOW_EXTRA)


class LightesotaCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, cfg):
        self.cfg = cfg
        session = async_get_clientsession(hass)

        async def transport(method, path, body, token):
            # No redirects: never forward bearer credentials to another origin.
            async with session.request(method, cfg[CONF_URL] + path, json=body,
                                       headers={"Authorization": f"Bearer {token}"},
                                       allow_redirects=False, timeout=8) as response:
                if response.status != 200:
                    return response.status, None
                return response.status, await response.json()

        self.client = Client(transport, cfg[CONF_TOKEN], cfg.get("operator_token"))
        super().__init__(hass, _LOGGER, name=DOMAIN,
                         update_interval=timedelta(seconds=cfg["poll_interval"]))

    async def _async_update_data(self):
        try:
            return await self.client.refresh()
        except ApiError as error:
            raise UpdateFailed(str(error)) from None

    async def execute(self, command, *, operator=False, context=None):
        from homeassistant.exceptions import HomeAssistantError
        try:
            data = await self.client.command(command, operator=operator,
                                             context_id=context.id if context else None)
        except ApiError as error:
            if not self.client.online:
                self.async_set_update_error(UpdateFailed(str(error)))
            elif self.client.state is not None:
                self.async_set_updated_data(self.client.state)
            raise HomeAssistantError(str(error)) from None
        self.async_set_updated_data(data)


async def async_setup(hass, config):
    if DOMAIN not in config:
        return True
    coordinator = LightesotaCoordinator(hass, config[DOMAIN])
    hass.data[DOMAIN] = coordinator
    # Failed startup stays unavailable and polls again; never restore HA's saved On state.
    await coordinator.async_refresh()
    for platform in ("light", "number", "button", "sensor"):
        hass.async_create_task(discovery.async_load_platform(hass, platform, DOMAIN, {}, config))
    return True
