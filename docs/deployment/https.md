# HTTPS and browser microphones

Browser microphone access needs a secure browser context. A plain HTTP LAN URL
such as `http://10.10.229.6:8787` does not provide `navigator.mediaDevices` in normal
browsers. Use the HTTPS origin served by an approved reverse proxy and a
certificate trusted by each client device. Loopback localhost can be a secure
development exception; a LAN IP is not that exception. Microphone permission is
still required and the browser must have an available input device.

The three sources are distinct:

- **Fixture microphones:** Music6/Music32 wash programs and laser sound presets;
  each fixture reacts independently. No browser audio or common beat phase.
- **Shared BPM clock:** operator BPM/tap/resync drives patterns and finite shows.
  It is not evidence of detected music.
- **Browser microphone:** optional analysis sent by the user's browser. Permission
  denial, device disconnect, silence or stale frames must remove the active-audio
  claim. Sound Reactive can fall back to the beat clock and labels that source.

No Sonos/Spotify audio capture is provided or configured here.

## Proxy configuration

[nginx.conf](nginx.conf) is a reviewable example to include in nginx's `http`
context after replacing the example hostname and **pre-provisioned** certificate
paths. It preserves WebSocket upgrade and Authorization headers. It does not
obtain certificates, alter DNS or install/restart nginx. Browser UI and `/ws`
must use the same HTTPS origin. Machine clients use the same origin and Bearer
authorization; they do not use share-link query tokens.

Bind Lightesota to loopback (`HOST=127.0.0.1`). Tokenless loopback administration
has been removed: a proxy connection from localhost cannot grant admin access.
The safe preview command retains `LIGHTESOTA_LOCALHOST_ADMIN=0` for clarity when
reviewing older releases. REST mutations always require explicit credentials; the machine API accepts
Bearer only. Configure the public sharing URL to the HTTPS origin. Retain the
process output veto until [operator commissioning](migration.md) is complete.

The example disables request logs to avoid retaining browser share-link tokens.
If operators enable logs later, scrub query strings, cookies and Authorization
headers first; do not use full-request dumps. Do not expose the raw HTTP port
externally or trust client-supplied forwarding headers for administrator access.

After future installation, verify from an authorized client: HTTPS certificate
trust, a viewer remains a viewer through the proxy, guest permissions stay intact,
unauthenticated POST is rejected, WebSocket reconnect works, browser microphone
permission/source/fallback labels work, and microphone disconnect/silence stops
claiming detected audio. Preview may be used throughout these checks. None of
these host, DNS, certificate or live device operations was performed here.
