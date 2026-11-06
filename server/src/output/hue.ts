import https from "node:https";
import type { PeerCertificate } from "node:tls";
import type { HueLightInfo } from "../../../shared/src/index.js";

/**
 * Signify's private CA for Hue bridges, as published in the Hue developer documentation. Bridges
 * on current firmware (and the BSB003 Bridge Pro) serve the v1 API over https only, with a
 * certificate issued by this CA whose common name is the bridge id. Requests verify the chain
 * against this CA and, once the bridge id is known, require the certificate's CN to match it.
 */
const HUE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICMjCCAdigAwIBAgIUO7FSLbaxikuXAljzVaurLXWmFw4wCgYIKoZIzj0EAwIw
OTELMAkGA1UEBhMCTkwxFDASBgNVBAoMC1BoaWxpcHMgSHVlMRQwEgYDVQQDDAty
b290LWJyaWRnZTAiGA8yMDE3MDEwMTAwMDAwMFoYDzIwMzgwMTE5MDMxNDA3WjA5
MQswCQYDVQQGEwJOTDEUMBIGA1UECgwLUGhpbGlwcyBIdWUxFDASBgNVBAMMC3Jv
b3QtYnJpZGdlMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEjNw2tx2AplOf9x86
aTdvEcL1FU65QDxziKvBpW9XXSIcibAeQiKxegpq8Exbr9v6LBnYbna2VcaK0G22
jOKkTqOBuTCBtjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNV
HQ4EFgQUZ2ONTFrDT6o8ItRnKfqWKnHFGmQwdAYDVR0jBG0wa4AUZ2ONTFrDT6o8
ItRnKfqWKnHFGmShPaQ7MDkxCzAJBgNVBAYTAk5MMRQwEgYDVQQKDAtQaGlsaXBz
IEh1ZTEUMBIGA1UEAwwLcm9vdC1icmlkZ2WCFDuxUi22sYpLlwJY81Wrqy11phcO
MAoGCCqGSM49BAMCA0gAMEUCIEBYYEOsa07TH7E5MJnGw557lVkORgit2Rm1h3B2
sFgDAiEA1Fj/C3AN5psFMjo0//mrQebo0eKd3aWRx+pQY08mk48=
-----END CERTIFICATE-----`;

function hueRequest(ip: string, method: string, path: string, body: unknown, expectBridgeId: string | null, timeoutMs = 4000): Promise<{ body: unknown; cn: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const checkServerIdentity = (_host: string, cert: PeerCertificate) => {
      const cn = String(cert.subject?.CN ?? "").toLowerCase();
      if (expectBridgeId && cn !== expectBridgeId.toLowerCase()) return new Error(`bridge certificate is for ${cn || "?"}, expected ${expectBridgeId}`);
      return undefined;
    };
    const req = https.request({
      host: ip, port: 443, method, path, ca: HUE_ROOT_CA, checkServerIdentity, timeout: timeoutMs,
      headers: { "content-type": "application/json", ...(data ? { "content-length": Buffer.byteLength(data) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      const cn = String((res.socket as import("node:tls").TLSSocket).getPeerCertificate?.()?.subject?.CN ?? "");
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { try { resolve({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), cn }); } catch { reject(new Error(`bridge sent a non-JSON reply (${res.statusCode})`)); } });
    });
    req.on("timeout", () => req.destroy(new Error("bridge did not answer in time")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Minimal Hue Bridge v1 API client with pairing and a rate-limited color updater. */
export class HueBridge {
  private queue = new Map<string, { xy: [number, number]; bri: number; on: boolean }>();
  private lastSent = new Map<string, { xy: [number, number]; bri: number; on: boolean; at: number }>();
  private timer: NodeJS.Timeout | null = null;
  lastError: string | undefined;
  connected = false;
  lightCount = 0;

  /** Learned from /api/0/config on the first request; every later request must present a certificate for it. */
  bridgeId: string | null = null;

  constructor(public ip: string, public username: string, public rateHz: number) {}

  private path(path: string) { return `/api/${this.username}${path}`; }

  /** Read the bridge id over a chain-verified connection and pin it for the rest of the session. */
  private async ensureBridgeId() {
    if (this.bridgeId) return;
    const { body, cn } = await hueRequest(this.ip, "GET", "/api/0/config", undefined, null);
    const id = String((body as { bridgeid?: string })?.bridgeid ?? "");
    if (!id) throw new Error("bridge did not report an id");
    if (cn.toLowerCase() !== id.toLowerCase()) throw new Error(`bridge certificate (${cn}) does not match its id (${id})`);
    this.bridgeId = id;
  }
  private async call(method: string, path: string, body?: unknown, timeoutMs = 4000): Promise<unknown> {
    await this.ensureBridgeId();
    return (await hueRequest(this.ip, method, path, body, this.bridgeId, timeoutMs)).body;
  }

  async pair(): Promise<string> {
    requirePhysicalOutput();
    const body = (await this.call("POST", "/api", { devicetype: "lightesota#server" })) as Array<{ success?: { username: string }; error?: { type: number; description: string } }>;
    const first = body[0];
    if (first?.success?.username) { this.username = first.success.username; return this.username; }
    throw new Error(first?.error?.description ?? "unexpected bridge response");
  }

  async listLights(): Promise<HueLightInfo[]> {
    if (!this.username) throw new Error("Hue bridge is not paired yet");
    const body = (await this.call("GET", this.path("/lights"))) as Record<string, { name: string; type: string; state: { on: boolean; reachable: boolean } }> | Array<{ error: { description: string } }>;
    if (Array.isArray(body)) throw new Error(body[0]?.error?.description ?? "bridge error");
    const lights = Object.entries(body).map(([id, l]) => ({ id, name: l.name, type: l.type, reachable: l.state?.reachable ?? true, on: l.state?.on ?? false }));
    this.connected = true;
    this.lastError = undefined;
    this.lightCount = lights.length;
    return lights;
  }

  /** Queue a color for a light; the flush loop sends at most rateHz commands per second. */
  setColor(lightId: string, r: number, g: number, b: number, dim: number) {
    const bri = Math.round(Math.max(0, Math.min(1, Math.max(r, g, b) * dim)) * 254);
    const on = bri > 0;
    const xy = rgbToXy(r, g, b);
    this.queue.set(lightId, { xy, bri: Math.max(1, bri), on });
    this.ensureLoop();
  }

  private ensureLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flushOne(), 1000 / Math.max(1, this.rateHz));
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  private async flushOne() {
    if (!this.username) return;
    // Pick the queued light whose change is largest / oldest.
    let bestId: string | null = null, bestScore = -1;
    const now = Date.now();
    for (const [id, s] of this.queue) {
      const last = this.lastSent.get(id);
      let score = 1;
      if (last) {
        const d = Math.abs(last.bri - s.bri) / 254 + Math.hypot(last.xy[0] - s.xy[0], last.xy[1] - s.xy[1]) * 4 + (last.on !== s.on ? 1 : 0);
        const age = (now - last.at) / 1000;
        if (d < 0.02 && age < 10) { this.queue.delete(id); continue; }
        score = d + age * 0.05;
      } else score = 10;
      if (score > bestScore) { bestScore = score; bestId = id; }
    }
    if (!bestId) return;
    const s = this.queue.get(bestId)!;
    this.queue.delete(bestId);
    const body = s.on ? { on: true, xy: s.xy, bri: s.bri, transitiontime: 1 } : { on: false, transitiontime: 1 };
    try {
      const out = (await this.call("PUT", this.path(`/lights/${bestId}/state`), body, 2000)) as Array<{ error?: { description: string } }>;
      if (epoch !== this.epoch) return;
      const err = out.find((o) => o.error)?.error?.description;
      if (err) throw new Error(err);
      this.lastSent.set(bestId, { ...s, at: now });
      this.connected = true;
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message;
      this.connected = false;
    }
  }
}

/** sRGB -> CIE xy (Hue "wide gamut" friendly). */
export function rgbToXy(r: number, g: number, b: number): [number, number] {
  const lin = (c: number) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  r = lin(r); g = lin(g); b = lin(b);
  const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
  const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
  const Z = r * 0.000088 + g * 0.072310 + b * 0.986039;
  const sum = X + Y + Z;
  if (sum === 0) return [0.3127, 0.329];
  return [round4(X / sum), round4(Y / sum)];
}
const round4 = (v: number) => Math.round(v * 10000) / 10000;
