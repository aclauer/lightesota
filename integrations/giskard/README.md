# Giskard → Lightesota

This native Hermes plugin adds **only** `lighting_state`, `lighting_apply`, and
`lighting_stop` to Giskard. It calls Lightesota's authenticated API; it never
sends DMX, talks to Hue/Home Assistant directly, runs shell commands, or changes
Giskard's model. Keep Giskard's existing DeepSeek Flash/max configuration and
other tool restrictions intact.

## What teammates can request

In the allowlisted Slack channel, mention Giskard to start a request. Examples:

- “What ordinary lights are configured?”
- “Set washes 1 and 2 to orange at 30%.”
- “Put washes 3 and 4 in Music6 mode.”
- “Stop the lighting.”

An apply is one batch of the same operation per human message. Target IDs come
from `lighting_state`; the model does not supply identity, credentials, endpoint
URLs, or an authorization lease. Lasers, haze, strobe, schedules, arbitrary code,
and raw DMX are not exposed. Normal Lightesota controls remain available to the
operator independently of Slack.

Results describe **commanded state, not observed light output**. A zero master,
blackout, released output, preview or uncommissioned output is reported rather
than silently overridden. Stop is lease-independent but still requires valid
Slack context and server authentication; it stops Lightesota, not an independent
Home Assistant sender. Stop through Slack still depends on the gateway, network
and model choosing the tool—use Lightesota's direct Stop for an immediate operator
control.

## Deployment prerequisites

Do not enable the plugin or API just because the code has been published.

1. Lightesota must run on the always-on office host. The observed installation is
   the Home Assistant `local_lightesota` add-on at `10.10.0.192:8787`, with data in
   `/share/lightesota`. The repository's Compose file is **not** that add-on's
   configuration. Its wrapper must explicitly pass the new environment variables.
2. Verify one output authority per the [migration guide](../../docs/deployment/migration.md).
   Neither this plugin nor its publication performs that migration.
3. Establish a private, access-controlled HTTPS route from the company Giskard
   instance to the Lightesota API. The plugin requires a fixed HTTPS origin,
   normal certificate validation, no redirects and no environment HTTP proxy.
   Do not expose port 8787 or the unprotected Hermes inference proxy to the public
   Internet. A tunnel must terminate on loopback at Lightesota (or provide a real
   TLS socket); forged forwarded headers cannot satisfy the server's transport gate.
4. Discover the real Slack workspace ID and explicit authorized member IDs. Keep
   `#giskard` channel ID `C0CB4RFQ55Y`, DMs disabled and unknown users denied.
5. Use a **dedicated random integration token**, shared only between the server
   and Giskard. It is not a Slack token, a browser admin token or a Nous OAuth
   credential. Enter secrets through the operator's protected configuration/KEYS
   interface, never chat, Git, a command-line argument or a report.

The company Nous authorization for Lightesota's inference proxy is separate from
this plugin; see [Hermes inference](../../docs/hermes-inference.md). Existing
Giskard Slack credentials do not need replacing.

## Configuration

Both the Lightesota server and Giskard gateway need the same enabled flag, token,
workspace, channel and user allowlist. All flags default to disabled or invalid.

| Variable | Value |
| --- | --- |
| `LIGHTESOTA_GISKARD_ENABLED` | `0` while staging; exactly `1` only for activation |
| `LIGHTESOTA_GISKARD_TOKEN` | Dedicated secret, 32–1024 printable non-whitespace ASCII characters |
| `LIGHTESOTA_GISKARD_TEAM_ID` | Actual Slack team ID; no display name |
| `LIGHTESOTA_GISKARD_CHANNEL_ID` | `C0CB4RFQ55Y` |
| `LIGHTESOTA_GISKARD_USER_IDS` | Explicit comma-separated Slack user IDs; no wildcard |
| `LIGHTESOTA_GISKARD_BASE_URL` | **Giskard only:** protected HTTPS origin, no path/query/credentials |
| `LIGHTESOTA_OUTPUT_COMMISSIONED` | **Server only:** existing operator-controlled output gate |

The complete server request/response contract and bounds are in
[docs/giskard-lighting.md](../../docs/giskard-lighting.md).

## Install the reviewed plugin

Use a checkout pinned to the reviewed Lightesota commit on the **company Giskard
host**, not Ari's personal Hermes profile. This is a subdirectory of a monorepo,
not a standalone plugin Git repository. The supported native drop-in layout is:

```text
$HERMES_HOME/plugins/lightesota/
├── __init__.py
└── plugin.yaml
```

With `HERMES_HOME` explicitly set to the intended company profile and the working
directory at the pinned checkout, a first install is:

```sh
: "${HERMES_HOME:?Set the company Giskard profile home first}"
test ! -e "$HERMES_HOME/plugins/lightesota" || exit 1
mkdir -p "$HERMES_HOME/plugins"
cp -R integrations/giskard/hermes-plugin "$HERMES_HOME/plugins/lightesota"
hermes plugins list
```

For a dashboard-only install, copy those exact two files with its Files interface
into the same profile-relative directory. Do not upload this repository, private
local profiles, histories or credentials. For an upgrade, preserve the previous
plugin directory outside the discovery tree before replacing it.

Enable `lightesota` through the Plugins UI or `hermes plugins enable lightesota`.
Allow its three tools in the gateway's tool policy without enabling shell,
terminal, browser, filesystem, memory, cron or unrelated toolsets. Preserve every
existing plugin and source allowlist. Keep `LIGHTESOTA_GISKARD_ENABLED=0` until the
route, server configuration and identity policy are verified. Reload/restart the
company gateway through its existing deployment controls and inspect a **new**
conversation's tool list; a copied file alone is not activation.

## Identity, cancellation and replay behavior

The pre-inference middleware captures a server lease once. It uses task-local
Hermes Slack metadata, not prompt text or tool arguments. A stable identifier
hashes workspace, channel, actor and Slack message ID, so delivery retries with a
new Hermes session/turn still address the same server replay record. The local
lease is additionally bound to the original Hermes session/turn; another runtime
turn cannot borrow it. Failed lease requests and uncertain applies are not retried.

The tool middleware binds trusted context only for the duration of the handler.
Direct handler calls, DMs, other platforms, cron, missing context and foreign
actors fail closed, even if Hermes treats a middleware exception as fail-open.
A single apply attempt consumes local authority, including a timeout. The server
also checks its one-use lease, boot and original ownership generation immediately
before applying controls. Stop or a manual takeover defeats an older response.

The server's lease ledger is boot-local; the plugin additionally commits each
stable event hash to `$HERMES_HOME/plugin-data/lightesota/events.db` **before**
requesting authority. This SQLite receipt survives gateway/backend restarts and
stores no prompts, tokens or leases. Keep this database across plugin upgrades
and profile moves; deleting it removes replay protection. Missing Hermes plugin
storage support, database I/O failure or the 100,000-receipt cap blocks new apply
authority without disabling authenticated state/Stop. No receipt is automatically
evicted. Verify the deployed Hermes runtime supports `plugins.plugin_storage`
and uses persistent profile storage before activation; local-runtime tests do
not establish compatibility with the hosted Giskard version. Do not replay queued
historical messages after a cutover or restart.

## Validation and acceptance

Offline package tests (no dependencies, real profile or hardware):

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s integrations/giskard/tests -v
LIGHTESOTA_PREVIEW=1 node --import tsx --test server/src/api/giskard.test.ts
```

The source has also been exercised through the real Hermes plugin loader,
request/tool middleware and registry in a throwaway profile, and against the real
loopback Lightesota preview HTTP server. These checks do **not** prove cloud TLS,
Nous authorization, live Slack delivery or physical lights.

Before calling the integration live, verify in order:

- A new company gateway conversation exposes exactly the three new lighting tools
  alongside its existing authorized tools, with no general-purpose tool expansion.
- An allowlisted `#giskard` mention can read sanitized state over the protected
  route. DMs, a foreign user/channel and model-supplied identity cannot call it.
- In an isolated preview, one apply changes only the requested targets; duplicate
  delivery cannot repeat it; Stop invalidates a previously captured turn. Restart
  the gateway and preview backend, retaining the profile database: the same Slack
  message must acquire no new lease; a genuinely new message may acquire one.
  Verify database availability and these checks before physical commissioning.
- After separately authorizing an onsite ordinary-light check, read back accepted
  state and obtain the observer's confirmation. Do not test lasers/haze/strobe.

For rollback, disable the plugin and set the API's enabled flag to `0`, then reload
the respective services. This does not roll back the inference provider, change
saved scenes or affect existing operator authentication.
