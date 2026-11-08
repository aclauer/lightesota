#!/bin/sh
# Container entrypoint. Under Home Assistant the app's options arrive in /data/options.json;
# turn the ones we know into environment variables, then start the server. Outside Home
# Assistant (docker-compose) the file does not exist and the environment is used as is.
set -e
if [ -f /data/options.json ]; then
  eval "$(node -e '
    const o = require("/data/options.json");
    const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
    if (o.anthropic_api_key) console.log("export ANTHROPIC_API_KEY=" + q(o.anthropic_api_key));
    if (o.admin_token) console.log("export LIGHTESOTA_ADMIN_TOKEN=" + q(o.admin_token));
    if (o.data_dir) console.log("export LIGHTESOTA_DATA=" + q(o.data_dir));
    if (o.localhost_admin === false) console.log("export LIGHTESOTA_LOCALHOST_ADMIN=0");
  ')"
fi
mkdir -p "${LIGHTESOTA_DATA:-/data}"
exec node server/dist/server/src/index.js
