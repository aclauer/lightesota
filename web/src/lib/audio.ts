/**
 * Microphone analysis in the browser: RMS level, bass/mid/high bands and a simple onset-based
 * beat detector with tempo estimation. Sends compact updates to the server so patterns can react.
 */
export interface AudioFrame { level: number; bass: number; mid: number; high: number; onset: boolean; bpm: number | null; }

/** Explain unavailable browser APIs before the user reaches a disabled microphone button. */
export function microphoneUnavailable(secure: boolean, hasMediaDevices: boolean): string | null {
  if (!secure) return "Browser microphone requires HTTPS or localhost. Plain HTTP on a LAN address cannot request microphone access; open the HTTPS address configured for this server.";
  if (!hasMediaDevices) return "This browser does not provide microphone capture. Use a supported browser over HTTPS, fixture microphones, or the shared BPM clock.";
  return null;
}

export class AudioAnalyzer {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private raf = 0;
  private freq: Uint8Array = new Uint8Array(0);
  private time: Uint8Array = new Uint8Array(0);
  private history: number[] = [];
  private onsets: number[] = [];
  private lastOnset = 0;
  private lastSend = 0;
  private smoothLevel = 0;
  private session = 0;
  running = false;
  bpm: number | null = null;
  onFrame: ((f: AudioFrame) => void) | null = null;
  onStop: ((reason: string) => void) | null = null;
  sensitivity = 1.4;

  async start() {
    if (this.running) return;
    const unavailable = microphoneUnavailable(window.isSecureContext, !!navigator.mediaDevices?.getUserMedia);
    if (unavailable) throw new Error(unavailable);
    const session = ++this.session;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (session !== this.session) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const ctx = new AC();
      this.ctx = ctx;
      await ctx.resume();
      if (session !== this.session) return;
      const src = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.5;
      src.connect(this.analyser);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.time = new Uint8Array(this.analyser.fftSize);
      const lost = () => {
        if (session !== this.session) return;
        this.stop();
        this.onStop?.("Browser microphone disconnected or muted. Shared BPM clock is available; start listening again when ready.");
      };
      for (const track of stream.getAudioTracks()) {
        track.addEventListener("ended", lost, { once: true });
        track.addEventListener("mute", lost, { once: true });
      }
      ctx.addEventListener("statechange", () => { if (this.running && ctx.state !== "running") lost(); });
      this.running = true;
      this.loop();
    } catch (error) {
      if (session === this.session) this.stop();
      throw error;
    }
  }

  stop() {
    this.session++;
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null; this.stream = null; this.analyser = null;
    this.history = []; this.onsets = []; this.bpm = null;
    this.smoothLevel = 0; this.lastOnset = 0; this.lastSend = 0;
  }

  private loop = () => {
    if (!this.running || !this.analyser || !this.ctx) return;
    this.raf = requestAnimationFrame(this.loop);
    const a = this.analyser;
    a.getByteFrequencyData(this.freq as Uint8Array<ArrayBuffer>);
    a.getByteTimeDomainData(this.time as Uint8Array<ArrayBuffer>);
    const binHz = this.ctx.sampleRate / a.fftSize;
    const band = (lo: number, hi: number) => {
      const i0 = Math.max(0, Math.floor(lo / binHz)), i1 = Math.min(this.freq.length - 1, Math.ceil(hi / binHz));
      let s = 0; for (let i = i0; i <= i1; i++) s += this.freq[i];
      return s / ((i1 - i0 + 1) * 255);
    };
    let sum = 0; for (let i = 0; i < this.time.length; i++) { const v = (this.time[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / this.time.length);
    const level = Math.min(1, rms * 3);
    const bass = band(20, 150), mid = band(150, 2000), high = band(2000, 8000);
    // Onset detection on bass energy against a rolling average.
    const e = bass * bass;
    this.history.push(e); if (this.history.length > 43) this.history.shift();
    const avg = this.history.reduce((x, y) => x + y, 0) / this.history.length;
    const now = performance.now();
    // A tempo estimate is evidence of recent onsets, never a permanently latched value.
    if (now - this.lastOnset > 3000) { this.bpm = null; this.onsets = []; }
    let onset = false;
    if (this.history.length > 20 && e > avg * this.sensitivity && e > 0.02 && now - this.lastOnset > 250) {
      onset = true; this.lastOnset = now;
      this.onsets.push(now); if (this.onsets.length > 24) this.onsets.shift();
      this.bpm = estimateBpm(this.onsets);
    }
    this.smoothLevel = this.smoothLevel * 0.7 + level * 0.3;
    if (now - this.lastSend > 50 || onset) {
      this.lastSend = now;
      this.onFrame?.({ level: round(this.smoothLevel), bass: round(bass), mid: round(mid), high: round(high), onset, bpm: this.bpm });
    }
  };
}

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Tempo from onset times: histogram of inter-onset intervals folded into 70..180 BPM. */
function estimateBpm(onsets: number[]): number | null {
  if (onsets.length < 6) return null;
  const buckets = new Map<number, number>();
  for (let i = 1; i < onsets.length; i++) {
    for (let j = Math.max(0, i - 4); j < i; j++) {
      let bpm = 60000 / (onsets[i] - onsets[j]);
      while (bpm < 70) bpm *= 2;
      while (bpm > 180) bpm /= 2;
      const b = Math.round(bpm / 2) * 2;
      buckets.set(b, (buckets.get(b) ?? 0) + 1 / (i - j));
    }
  }
  let best = 0, bestBpm: number | null = null;
  for (const [b, n] of buckets) if (n > best) { best = n; bestBpm = b; }
  return bestBpm;
}
