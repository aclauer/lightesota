# Giskard Vercel ↔ HA bridge

Source for a purpose-specific lighting RPC mailbox. Live deployment, SDK/store acceptance,
Slack acceptance and physical commissioning remain with the deployment owner. This is
not a production-readiness claim. The HA app is the host; the laptop runs no connector daemon.

```text
Company Hermes Giskard (unchanged three tools)
  HTTPS POST state / lease / apply / stop, credential A
Vercel Node Function, production only, dimensionalos
  one private Blob: lightesota-giskard/mailbox-v1.json
  uncached origin GET + ETag compare-and-swap PUT
HA local_lightesota, outbound HTTPS session / poll / result, credential B
  persistent SQLite receipts + one serialized in-process connector
  fixed http://127.0.0.1:<actual app port>/api/integrations/giskard/..., credential C
Existing Lightesota router and ShowController
```

There is no route to `10.10.0.192` from Vercel, inbound HA tunnel, admin proxy,
arbitrary destination, extra model tool, UI, scheduler or new lighting sender.
Inference/provider settings, Andrew's data/features and existing hardware gates are unchanged.

## Deployment owner configuration

Use three independently generated secrets. Enter them only through protected Vercel,
HA and company Hermes configuration. Never place values in commands, URLs, source,
settings exports, model arguments or logs. The two secrets visible to each service
are checked for equality; the owner must also ensure A differs from C.

| Location | Non-secret configuration name | Value / relationship |
| --- | --- | --- |
| Vercel production | `GISKARD_RELAY_ENABLED` | `1` only after staging; unset disables |
| Vercel production, temporary diagnostics | `GISKARD_RELAY_DIAGNOSTICS` | Exactly `1` enables bounded storage-stage/category logs; unset disables |
| Vercel production | `GISKARD_RELAY_TOKEN` | Secret A; Giskard → relay |
| Vercel production | `GISKARD_CONNECTOR_TOKEN` | Secret B; HA → relay |
| Vercel production | `GISKARD_RELAY_TEAM_ID`, `GISKARD_RELAY_CHANNEL_ID`, `GISKARD_RELAY_USER_IDS` | Exact existing Slack team/channel/users; no wildcard |
| Vercel managed | `VERCEL=1`, `VERCEL_ENV=production` | Must be supplied by Vercel. Preview/development fail closed before storage access. Do not override these system variables. |
| Vercel managed | `BLOB_STORE_ID`, managed `VERCEL_OIDC_TOKEN` | Attach a **private** Blob store to this project's **Production environment only**; SDK obtains managed OIDC automatically. Do not copy OIDC tokens. |
| Vercel alternative | `BLOB_READ_WRITE_TOKEN` | Only if the owner chooses the supported protected token alternative; never copy to HA or Hermes |
| HA option → process environment | `giskard_relay_enabled` → `LIGHTESOTA_GISKARD_RELAY_ENABLED` | Default false / `0` |
| HA option → process environment | `giskard_relay_origin` → `LIGHTESOTA_GISKARD_RELAY_ORIGIN` | Fixed canonical `https://<production-host>`, no trailing slash, path, userinfo, query or fragment |
| HA password option → process environment | `giskard_connector_token` → `LIGHTESOTA_GISKARD_CONNECTOR_TOKEN` | Secret B |
| Existing HA password option | `giskard_token` → `LIGHTESOTA_GISKARD_TOKEN` | Secret C, used only for the existing protected loopback API |
| Existing HA options | `giskard_enabled`, `giskard_team_id`, `giskard_channel_id`, `giskard_user_ids` | Existing API enabled with the same exact allowlist; no commissioning implied |
| Existing company Giskard configuration | `LIGHTESOTA_GISKARD_BASE_URL` | Same fixed production HTTPS origin |
| Existing company Giskard protected configuration | `LIGHTESOTA_GISKARD_TOKEN` | Secret A, **not** C in this relay topology |

Keep the existing Hermes tool set, stable Slack receipts, provider configuration,
DeepSeek selection, credentials and unrelated profiles intact. Keep output/haze
commissioning false throughout software acceptance. Old HA option files default the
connector off even if an inherited environment attempted to enable it. Invalid new
connector options disable the connector without terminating the ordinary console.

### Vercel layout and installation

Use a dedicated project in Ari's existing **Dimensional Pro / `dimensionalos`** team.
Set `rootDirectory` to **`integrations/giskard-relay`**, framework to the Node HTTP server
layout (no Next application), Node runtime to **22.x**, and entrypoint to `server.js`.
The entrypoint calls `server.listen()`; it is also the same handler exercised by the
tests. Build command: `npm run build`. No static output directory is needed.

The package pins `@vercel/blob` **2.9.0** and has its own package.json and package-lock.json.
Parent installed the pinned SDK; the follow-up preserves both lockfiles. Do not add it to
HA. Use `npm ci` as the project's install command. Owner validation in a fresh checkout:

```sh
npm ci --prefix integrations/giskard-relay --ignore-scripts --no-audit --no-fund
npm run build --prefix integrations/giskard-relay
npm test --prefix integrations/giskard-relay
```

Adapter tests use the installed SDK's real `BlobPreconditionFailedError` and `BlobError`
classes, with injected get/put functions. Only the former is a definite CAS conflict.
The SDK has no `BlobAlreadyExistsError` export: generic `bad_request`, including an
initial-create conflict without a recognized precondition error, remains outcome unknown.
Exception text never determines retry behavior. These tests establish options and error
classification, not actual private-store behavior. Production must use consistent private
origin reads and conditional writes. Never substitute `head`, cached reads, public storage,
or unconditional overwrites. SDK abort/retry behavior and actual origin latency require
parent acceptance. The app responds within 5.5 seconds; provision enough function runtime
for response/cancellation cleanup (at least 10 seconds).

Private uncached GETs request `accept-encoding: identity` through SDK 2.9.0's supported
`headers` option. CAS still forwards the unchanged ETag from that same body read.
Parent's cloud probe reproduced compressed weak-tag CAS rejection for both larger JSON
cases; identity reads returned the same content with strong tags matching creation PUTs.
The identity-read cloud CAS probe and SFO1 live relay acceptance remain pending.

For a parent-owned diagnostic deployment, temporarily set `GISKARD_RELAY_DIAGNOSTICS=1`
in the protected production project configuration and inspect `giskard_relay_storage`
log records, then unset the flag. This does not enable the relay or bypass authentication.
Each record contains only fixed `event`, `operation`, `stage` and `code` labels. Reads
identify `get`, `metadata`, `body` or `parse`; CAS identifies `create` or `update`.
Codes are `ok`, `missing`, an allowlisted SDK error class, `SyntaxError`,
`TypeError`, the local `refused_unavailable` / `refused_expired` / `refused_body_too_large`
codes, or `unclassified`. No error text/stack, URL, credentials, headers, identity,
request, lease, ETag or mailbox bytes are logged. A successful parse is not mailbox
schema validation; a successful storage write is not a successful lighting operation.

Successful read metadata adds one four-field `read` / `metadata` record with code
`etag_strong_quoted`, `etag_weak` (canonical `W/` plus a quoted tag), or `etag_other`.
Only the shape is reported: no raw tag, hash, length or previous-tag tracking. The
original ETag is returned and used for CAS unchanged, including its quotes or `W/`.
This is diagnostic classification only; a weak tag does not by itself prove a
compression issue, and a strong tag does not exclude stale reads or contention.
The extra record consumes the same budget below (a read/parse/CAS attempt now
normally consumes three records). There are no additional storage operations.

The shared read/write budget permits at most 12 records per 60-second monotonic window
per loaded function instance, including successes. Excess records are dropped; there
is no queue, timer or durable counter. Concurrent requests share that budget, sink
failures consume it, and logging failures do not change storage return/throw behavior.
Cold starts reset the budget; this is not a fleet-wide logging cap. No log can also
mean the budget was exhausted, storage was never reached, SDK import failed, or an
operation has not settled. The SDK's `get()` collapses non-404 HTTP errors to generic
`BlobError`; generic PUT errors also cannot be distinguished further without unsafe
message inspection. The known, non-exported `BlobOidcEnvironmentNotAllowedError` is
recognized only by an exact constructor-name match on an SDK `BlobError` instance;
other SDK classes use `instanceof`. This classification is for logs only. Never infer HTTP status, OIDC cause
or write commitment from a generic category or response duration. API error bodies,
deadlines, retry/fencing rules and stored receipts are unchanged; do not reset data.

Parent deployment commands, **after review, commit and project/store configuration**.
Run from the repository root, linked by the parent to the dedicated bridge project whose
Root Directory is `integrations/giskard-relay` (not to another existing application):

```sh
vercel deploy --prod --scope dimensionalos
ha-app/deploy.sh --host root@10.10.0.192 --ref <reviewed-commit>
```

Those commands have **not** been run here. The existing HA deployment script ships a
committed archive, not this working tree. The root Dockerfile already compiles/copies the
server implementation; no second container or laptop service is needed. Use HA Node
**22.23.1 or newer in the 22.x line**, with `node:sqlite` available without a flag. Local
verification used Node 22.23.1. Keep HA data on persistent storage, normally
`/share/lightesota`; connector storage must support SQLite locking, sync and directory sync.

Enable the HA connector only after the production relay/store configuration is ready.
A newly provisioned HA ledger records a **pending** initialization state in SQLite schema
v2. While pending with zero mutation receipts, it remains eligible for explicit
non-overwriting mailbox creation across process restarts, including after a wrong token,
disabled relay or startup outage. Zero receipts alone never proves freshness. A confirmed
session or `session_busy` response commits **established** state with the same SQLite
exclusive lock and sync discipline before polling/dispatch. Once established, a missing
mailbox is terminal even when no mutations have occurred.

A lost initial creation acknowledgement still triggers `initialize:false` readback in the
running connector; it waits out any live session. A definitively absent mailbox may be
created only while durably pending. The existing `giskard-relay.initialized` marker retains
its exact `v1` content as a ledger-provisioning marker; the remote observation is stored in
SQLite. Recognized SQLite schema v1 migrates conservatively to established schema v2,
including empty legacy ledgers. Unknown marker/schema, inconsistent pending state with
receipts, interrupted local provisioning and corruption fail closed. Do not delete or edit
the database/marker to recover initialization. Older connector code rejects schema v2;
rollback disables the bridge and preserves its data for owner review.

## Protocol, bounds and failure semantics

Only exact POST request targets are accepted: the existing four Giskard paths and
`/api/connector/{session,poll,result}`. Encodings, trailing slashes, queries, traversal,
other methods, cookies and forwarding headers confer no authority. There is no CORS.
Bearer authentication uses SHA-256 and constant-time digest comparison before storage.
The relay also checks the exact Slack identity and narrow command shape before admission,
quotas or durable capacity. Fixture eligibility remains the existing backend's decision.

The single mailbox has a 768 KiB serialized cap. It holds at most four ordinary jobs and
one Stop job, including results. Request JSON is capped at 8192 bytes; backend responses
at 65536 bytes. Results use ordered base64 chunks of at most 5400 decoded bytes, at most
13 chunks; every result POST including its envelope stays below 8192 bytes. Ordinary
admission has 60/minute global and 30/minute per-user budgets. Stop has separate 30/minute
global and 10/minute per-user budgets, a separate slot, and separate receipt capacity.
Invalid credentials or denied identities consume none of those budgets.

Every mutation admission records a hash of action plus the four trusted identity fields
for **130 seconds**. There are at most **256 ordinary / 128 Stop temporary entries** for
new admission, covering all active/retained work and the 120-second lease binding plus
response transit. Existing quotas bound arrivals within that window below these limits.
State does not consume receipts. At most 128 lease hash bindings last at most 120 seconds
and are erased by Stop or session takeover. The mailbox is not permanent execution history.

Schema v1 migrates to v2 in the same CAS transition: preserve all legacy receipt hashes
for a full 130-second window, along with existing jobs, fences, session and bindings.
Structural validation still accepts up to the legacy 2048/512 counts during this window;
large legacy histories can temporarily block that lane's new admission until expiry.
The mailbox byte limit does not increase. Old relay code rejects v2, so rolling back to
it fails closed and requires owner review; never downgrade or reset the stored history.

Permanent replay authority is deliberately split:

- Cloud entries reject active/recent repeated or ambiguous admissions before dispatch.
  Sent jobs are never redelivered; Stop and session fences cancel older authority.
- HA commits every attempted lease/apply/Stop before backend dispatch. After cloud expiry,
  re-admitting the same attempted action produces an unconfirmed response at HA, without
  redispatch. Old applies also lose their lease binding on expiry, Stop or takeover.
- The trusted gateway commits the human event before requesting its first lease. Thus a
  lost admission, cancelled queued lease or lost poll reply that **never reached HA**
  cannot be resubmitted by the supported gateway, including after restart. The existing
  ingress no-historical-replay requirement also applies to old tool invocations.

The cloud and HA do not permanently remember an admission that never reached HA. A client
bypassing that trusted ingress with valid relay credentials could re-admit such an old event
after 130 seconds; HA has no receipt for it. Do not claim HA alone rejects those events or
infer an age from opaque identity hashes. The plugin now checks the original trusted Slack
message timestamp before hashing: canonical ASCII `10 digits.6 digits`, at most 120 seconds
old or 30 seconds ahead of finite wall time. It rechecks before authority acquisition and
all lighting tools, including after restart; unseen stale events are refused before receipts
or network. This closes the source-level unseen-old-event hold without changing the gateway
schema or persistent receipts. Hosted verification remains parent-owned: confirm original
message `ts` (not `thread_ts`), accurate wall time and both middleware hooks before activation.

Each transition retries **only definite CAS conflicts**, at most six attempts. An
ambiguous PUT is never treated as success or retried as a fresh operation. HTTP admission
owns its request ID before writing. The HTTP handler observes entry into the actual admission
CAS boundary: definite validation/read refusals with no write attempt return immediately,
without a cancellation read or uncertain-admission hold. Once any CAS was attempted, uncertainty
stays set across retries—even if an SDK retry echoes a precondition conflict and the next
read refuses a duplicate. Errors after that boundary return outcome unknown.

Ordinary requests still receive bounded best-effort cancellation and an uncertainty hold
when admission may have committed or a job was returned. **Stop is never cancelled by the
HTTP handler**, including caller disconnect, lost admission acknowledgement or finalization.
It retains its original dispatch cutoff and response deadline, with no retry or extension;
an uncertain Stop reply is still unknown, never queue-acceptance success. Poll claims mark
jobs sent atomically; sent jobs are never redelivered. Success
requires the actual backend JSON response, committed result and successful consumption
of that result. Queue acceptance, stale state or a cached success is never returned as success.

The HTTP deadline is **5.5 seconds from request arrival**, including body parsing, beneath
the unchanged Hermes client's 8-second timeout. Dispatch closes within 3.5 seconds of
admission and at least 1.5 seconds before that HTTP deadline. Slow bodies cannot extend it.
The connector subtracts outbound transit time conservatively using its monotonic clock,
and adds a 100 ms margin. Vercel instances must have reasonably synchronized clocks;
parent must verify time/latency behavior in the selected region. No remote operation is
retried or reacquired on timeout. “Unknown” explicitly allows that an effect occurred.

Pending bodies, result chunks and raw lease responses are stripped when expired on the
next successful mailbox access; remaining job shells disappear 10 seconds after expiry.
Consumed successful results are removed immediately. With a healthy connector, expiry
cleanup occurs on its next poll (up to 2 seconds idle). If both peers stop or Blob is
unavailable, expired bytes can remain in the **private** object until the next successful
access; they cannot be returned or executed. Blob provides no background TTL cleanup in
this design. There is no scheduler and no claim of guaranteed physical erasure during
an outage. HA/gateway replay receipts remain permanent; cloud fences persist and temporary
hashes expire on access. No raw prompts or credentials enter the mailbox.

### Stop, expiry and the effect boundary

Stop admission atomically increments the mailbox fence, cancels **all** older queued jobs
including lease requests, strips older results, clears lease bindings and takes the reserved
Stop slot. Old in-flight results cannot confer authority. The connector dispatches jobs
serially, prioritizes Stop, and only reports Stop success after `stopLighting` returns.
The backend's existing generation check rejects old applies after successful Stop.

Before local HTTP dispatch, SQLite commits the attempted action/identity hash with
`synchronous=FULL`, `fullfsync=ON`, a rollback journal and an exclusive connection lock.
A crash before send may lose an operation; a crash after effect may lose its acknowledgement.
Both consume the receipt. Neither can replay it. The ledger holds at most 100000 ordinary
and 10000 Stop receipts. Corruption, sync failure, capacity or an already-held lock fails
closed; the ordinary console continues. Preserve **both** `giskard-relay.sqlite` and
`giskard-relay.initialized`, including SQLite's journal when backing up a running process.
Prefer a stopped, consistent backup. Never restore an older receipt history as a replay reset.

The optional `X-Lightesota-Relay-Dispatch` header references an in-memory one-use permit
bound to the exact action/body, monotonic deadline and fence. The existing router checks
it synchronously immediately before state/lease/Stop or the apply mutation batch. It can
only restrict existing bearer, socket, identity, lease and commissioning checks. A timed-out,
aborted, replaced or restarted connector has no usable permit; delayed delivered body bytes
cannot execute merely because an HTTP abort failed to retract them. Calls without that
header keep the existing direct API behavior.

For ordinary requests, CAS is the ordering point for **queued cancellation versus dispatch**.
If cancellation wins, there is no dispatch. Admitted Stop survives caller disconnect within
its original cutoff. If dispatch wins, the request is in flight and its outcome may
be unknown until Stop is acknowledged. A caller's physical disconnect cannot be observed
instantaneously on HA; an already-dispatched effect may happen before HA receives Stop or
the permit expires. Stop admission itself is not a physical interlock. This is not an
exactly-once distributed execution claim; it is at-most-once attempts with explicit loss.
An old request retained in the mailbox cannot obtain authority after Stop; its in-flight
result is rejected even if HA had already minted a lease. After cloud retention expires,
permanent attempted-action denial at HA and the trusted ingress rules above apply.
The plugin rejects stale unseen Slack events using the original trusted message timestamp;
the relay still cannot infer an age from the opaque `turnId`. Hosted metadata/hook verification
remains required.

One process owns the SQLite lock. Cloud sessions last 30 seconds, require recent health
(12 seconds) for new admission and cannot be stolen while live. Polls renew at most once
per 8 seconds. Expired sessions cannot poll or submit results; takeover fences prior work.
On transport loss, startup failure or local session expiry, the connector closes the
permit, abandons the session, and automatically requests a **new random incarnation**.
Retry waits are 1, 2, 4, 8, then at most 15 seconds, reset after a successful poll. An idle
healthy connector needs no restart after an outage. New sessions accept only new work:
no old backend operation, permit, lease or result is resent to recover an uncertain outcome.
The same exclusive SQLite owner and permanent receipts survive every retry. A different
live session remains protected until its TTL expires, including after an ambiguous
session write. The local deadline clock stays monotonic. Stop/shutdown cancels the wait
and dispatch before the existing blackout/close lifecycle. Invalid configuration,
protocol corruption, known-missing storage and failed receipt writes disable the connector
for operator review; retries never reset storage.

Idle polling backs off to one origin read every 2 seconds; heartbeats/cleanup only write
when material state changes. Active RPC waits perform at most 25 reads at 200 ms spacing,
and each normal request/result transition requires CAS writes. Larger state responses
require extra result chunk writes. This is a low-volume integration, not a streaming
transport. Measure real Blob operations/latency; no billing total is asserted.

## Parent acceptance and rollback

Offline and parent loopback commands, from the repository root:

```sh
export PATH=/Users/ameri/.local/bin:$PATH
export TMPDIR=/Users/ameri/.hermes/cache/scratch PYTHONDONTWRITEBYTECODE=1
export LIGHTESOTA_OUTPUT_COMMISSIONED=0 LIGHTESOTA_HAZE_COMMISSIONED=0
export NODE_OPTIONS='--require /Users/ameri/Projects/lightesota-integration-20261106/qa/hardware-veto.cjs'
npm test
npm run typecheck
npm run build
node --test integrations/giskard-relay/test/*.test.js
node --test ha-app/run.test.mjs
python3 -m unittest discover -s ha-app/tests -v
python3 -m unittest discover -s integrations/giskard/tests -v
python3 -m unittest discover -s integrations/home_assistant/tests -v
LIGHTESOTA_PREVIEW=1 BRIDGE_LOOPBACK_TEST=1 node --import tsx --test server/src/api/giskard-bridge.test.ts
git diff --check
```

The normal vertical tests use actual Node HTTP streams, Express, relay transitions,
connector and SQLite, substituting only external Blob consistency and unavailable sockets.
The `BRIDGE_LOOPBACK_TEST=1` selector uses actual numeric loopback listeners and real
connector → backend HTTP instead; the sandbox rejected listening with `EPERM` in initial
work. Parent reports all five original socket vertical tests passed under the permanent
hardware veto. The follow-up adds outage and 2,055 completed lease flows using injected time;
parent should rerun the expanded selector unchanged in a permitted environment. It still
uses synthetic credentials and an external fake CAS store, not a Vercel store.

Parent live checks, in order:

1. Use the pinned SDK/lockfile; deploy the reviewed subdirectory into `dimensionalos`.
   Verify one private store, production-only attachment, Node version and no public blob.
   In a preview deployment verify every route fails closed even with credentials present.
   Verify raw encoded/traversal/trailing-slash/query variants remain refused through Vercel's
   edge routing, since local tests cannot establish the deployed platform's normalization.
2. Deploy the reviewed HA commit; enter B/C and the exact identity options through HA.
   Keep ordinary output and haze uncommissioned. Enable connector and API, and verify
   `local_lightesota` startup without a connector error. No inference configuration change.
3. From the company Giskard host, issue a **new allowlisted Slack state request**, then a
   **new Stop request**. The plugin's fixed HTTPS client supplies A and trusted identity.
   Require actual backend state/Stop acknowledgement under 8 seconds; observe HA stopped
   state independently. Check denied foreign/DM contexts and the unchanged three-tool surface.
4. In an isolated, uncommissioned acceptance installation with production-gated relay
   configuration (Vercel Preview must remain denied), run one apply and lose its response.
   Interrupt startup, then interrupt cloud access beyond 30 seconds; verify recovery under
   a new session without restarting Lightesota or replaying work. Redeploy the relay and
   restart connector/backend while retaining receipts. Check stale pre-Stop leases,
   disconnected HA, expired jobs, ambiguous first creation and concurrent CAS conflicts
   against the actual private store. Never inject these failures into commissioned hardware.
5. Ordinary-light commissioning/onsite observation is a separate owner action. No lasers,
   haze, strobe or raw DMX tests are authorized by software acceptance.

For the parent's explicit HTTPS state/Stop probe, run the following from a reviewed checkout
on the company gateway host **only after authorizing Stop at that time**. Existing protected
environment supplies the plugin origin, A, team and channel; set non-secret
`GISKARD_ACCEPTANCE_USER_ID` to the actual authorized operator's Slack ID. It uses the shipped
8-second, HTTPS-only, no-redirect client and prints no secrets or lease material. This probe
does not establish Slack middleware acceptance; the real Slack checks above are also required.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 - <<'PY'
import importlib.util, json, os, sys, uuid
spec = importlib.util.spec_from_file_location("lighting_probe", "integrations/giskard/hermes-plugin/__init__.py")
plugin = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = plugin
spec.loader.exec_module(plugin)
client = plugin.Client(os.environ["LIGHTESOTA_GISKARD_BASE_URL"], os.environ["LIGHTESOTA_GISKARD_TOKEN"])
identity = {"teamId": os.environ["LIGHTESOTA_GISKARD_TEAM_ID"],
            "channelId": os.environ["LIGHTESOTA_GISKARD_CHANNEL_ID"],
            "userId": os.environ["GISKARD_ACCEPTANCE_USER_ID"],
            "turnId": "operator-acceptance-" + uuid.uuid4().hex}
for action in ("state", "stop"):
    result = client.post(action, {"identity": identity})
    state = result.get("state", {})
    print(json.dumps({"action": action, "ok": result.get("ok"),
                      "outputStatus": state.get("outputStatus"), "stopped": state.get("stopped")}))
    assert result.get("ok") is True
    if action == "stop":
        assert state.get("stopped") is True
PY
```

For rollback, disable `giskard_relay_enabled` in HA and `GISKARD_RELAY_ENABLED` in the Vercel
production project, and disable the company lighting plugin if abandoning the connection.
Restart HA through its existing app controls; the existing blackout behavior remains.
Retain the mailbox with its fences/session, SQLite/marker and Hermes event receipts. Do not clear the ledger,
delete the Blob or change data directories to recover capacity. Restore reviewed source
using the existing HA rollback procedure without replacing saved data or newer receipts.
Inference settings, Andrew's features, console access and output/haze commissioning gates
are independent of this rollback.
