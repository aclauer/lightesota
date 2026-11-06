import assert from "node:assert/strict";
import test from "node:test";
import * as audio from "../src/lib/audio.js";

/** Only in-memory browser primitives: no device, network or real microphone access. */
function browser() {
  let now = 100;
  let tick: (() => void) | null = null;
  class Track extends EventTarget { stopped = false; stop() { this.stopped = true; } }
  const track = new Track();
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let context: Context;
  class Context extends EventTarget {
    state = "running";
    constructor() { super(); context = this; }
    sampleRate = 48000;
    async resume() {}
    async close() {}
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() {
      return { fftSize: 1024, frequencyBinCount: 512, smoothingTimeConstant: 0,
        getByteFrequencyData: (array: Uint8Array) => array.fill(0),
        getByteTimeDomainData: (array: Uint8Array) => array.fill(128) };
    }
  }
  const replacements: Record<string, unknown> = {
    window: { isSecureContext: true, AudioContext: Context },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    performance: { now: () => now },
    requestAnimationFrame: (callback: () => void) => { tick = callback; return 1; },
    cancelAnimationFrame: () => { tick = null; },
  };
  const originals = new Map(Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return {
    track, stream,
    suspend() { context.state = "suspended"; context.dispatchEvent(new Event("statechange")); },
    advance(ms: number) { now += ms; tick?.(); },
    restore() { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}

test("unavailable browser microphones explain HTTPS before any permission request", () => {
  assert.match(audio.microphoneUnavailable(false, false)!, /HTTPS.*localhost/);
  assert.match(audio.microphoneUnavailable(true, false)!, /does not provide microphone/);
  assert.equal(audio.microphoneUnavailable(true, true), null);
});

test("ended, muted and interrupted fake microphones stop analysis and notify the UI", async () => {
  for (const event of ["ended", "mute", "suspended"]) {
    const fake = browser();
    const analyzer = new audio.AudioAnalyzer();
    try {
      let stopped = "";
      analyzer.onStop = (reason) => { stopped = reason; };
      await analyzer.start();
      analyzer.bpm = 120;
      if (event === "suspended") fake.suspend();
      else fake.track.dispatchEvent(new Event(event));
      assert.equal(analyzer.running, false);
      assert.equal(analyzer.bpm, null);
      assert.equal(fake.track.stopped, true);
      assert.match(stopped, /disconnected or muted/);
    } finally { analyzer.stop(); fake.restore(); }
  }
});

test("silence clears a previous tempo estimate instead of claiming detected BPM", async () => {
  const fake = browser();
  const analyzer = new audio.AudioAnalyzer();
  try {
    const frames: audio.AudioFrame[] = [];
    analyzer.onFrame = (frame) => frames.push(frame);
    await analyzer.start();
    analyzer.bpm = 120;
    fake.advance(4000);
    assert.equal(frames.at(-1)?.bpm, null);
    assert.equal(frames.at(-1)?.level, 0);
  } finally { analyzer.stop(); fake.restore(); }
});

test("Stop during a pending permission result cannot restart analysis", async () => {
  const fake = browser();
  const analyzer = new audio.AudioAnalyzer();
  try {
    let resolve!: (stream: unknown) => void;
    navigator.mediaDevices.getUserMedia = () => new Promise((done) => { resolve = done; }) as Promise<MediaStream>;
    const start = analyzer.start();
    analyzer.stop();
    resolve(fake.stream);
    await start;
    assert.equal(analyzer.running, false);
    assert.equal(fake.track.stopped, true);
  } finally { analyzer.stop(); fake.restore(); }
});
