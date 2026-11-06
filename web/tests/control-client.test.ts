import assert from "node:assert/strict";
import test from "node:test";

test("browser store binds generation at send, keeps Stop available, and never replays disconnected controls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    sent: Record<string, unknown>[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) { Socket.instances.push(this); }
    open() { this.readyState = Socket.OPEN; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    send(text: string) { this.sent.push(JSON.parse(text)); }
    receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  }
  class Track extends EventTarget { stopped = false; stop() { this.stopped = true; } }
  const track = new Track();
  class AudioContext extends EventTarget {
    state = "running";
    sampleRate = 48000;
    async resume() {}
    async close() {}
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, frequencyBinCount: 512, smoothingTimeConstant: 0,
      getByteFrequencyData: (array: Uint8Array) => array.fill(0), getByteTimeDomainData: (array: Uint8Array) => array.fill(128) }; }
  }
  const fake: Record<string, unknown> = {
    WebSocket: Socket,
    window: { isSecureContext: true, AudioContext, setTimeout, setInterval },
    document: { documentElement: { dataset: {} } },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) } },
    location: { protocol: "https:", host: "preview.invalid", hash: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: { replaceState() {} },
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  };
  const original = new Map(Object.keys(fake).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(fake)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    // The real store and real WS client run against memory-only browser and socket objects.
    const { useStore } = await import("../src/state/store.js");
    const socket = Socket.instances[0];
    assert.equal(socket.url, "wss://preview.invalid/ws");
    socket.open();
    socket.receive({ type: "show", show: { generation: 12, audio: { active: false, source: null, level: 0, bpm: null, followBpm: false } } });
    useStore.getState().send({ type: "setWash", fixtureIds: ["w1"], patch: { mode: "normal" } });
    assert.equal(socket.sent.at(-1)?.generation, 12);
    const queuedOld = structuredClone(socket.sent.at(-1));
    useStore.getState().send({ type: "stopLighting" });
    assert.equal(socket.sent.at(-1)?.type, "stopLighting");
    assert.equal(socket.sent.at(-1)?.generation, undefined);
    socket.receive({ type: "show", show: { generation: 13, audio: { active: false, source: null, level: 0, bpm: null, followBpm: false } } });
    assert.equal(queuedOld?.generation, 12, "a queued old command must never be rewritten into the new generation");
    socket.receive({ type: "error", text: "Stale control generation; refresh state and deliberately retry" });
    assert.match(useStore.getState().toasts.at(-1)!.text, /Stale control generation/);
    useStore.getState().send({ type: "setWash", fixtureIds: ["w1"], patch: { brightness: 25 } });
    assert.equal(socket.sent.at(-1)?.generation, 13);
    await useStore.getState().startMic();
    assert.equal(socket.sent.at(-1)?.type, "audio");
    assert.equal(socket.sent.at(-1)?.generation, 13);
    const pending = useStore.getState().request({ type: "takeManualControl" });
    const rejected = assert.rejects(pending, /Disconnected: command result is unknown/);
    socket.close();
    await rejected;
    assert.equal(track.stopped, true);
    assert.equal(useStore.getState().mic.running, false);
    assert.equal(useStore.getState().show!.audio.active, false);
    const count = socket.sent.length;
    useStore.getState().send({ type: "setMaster", master: 1 });
    assert.equal(socket.sent.length, count);
    assert.match(useStore.getState().toasts.at(-1)!.text, /command was not sent/);
    await assert.rejects(useStore.getState().request({ type: "armLasers", armed: true }), /command was not sent/);
    t.mock.timers.tick(500);
    const reconnected = Socket.instances.at(-1)!;
    assert.notEqual(reconnected, socket);
    reconnected.open();
    assert.deepEqual(reconnected.sent.map((message) => message.type), ["ping"], "reconnect must not replay old lighting or laser commands");
    useStore.getState().stopMic();
  } finally {
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
