// A stand-in for the browser's microphone objects (getUserMedia, AudioContext, AudioWorkletNode, the
// permissions query), for tests of Microphone and model.listen() in Node. The "device" plays the samples it
// is given in blocks, as an AudioWorklet posts them; a test drives what a browser would do by itself:
// mute and unmute the track, change the device, suspend the context, refuse the permission.
//
//   const mic = fakeMicrophone({ sampleRate: 48000 });
//   const session = await model.listen();            // with seams.microphone = mic.seams
//   mic.play(samples);                                // the device delivers audio
//   mic.track.fire('mute');                           // an interruption
export function fakeMicrophone({ sampleRate = 48000, permission = 'prompt', deny = null, block = 960 } = {}) {
  const events = (o) => {
    const l = new Map();
    o.addEventListener = (t, f) => { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); };
    o.removeEventListener = (t, f) => { if (l.has(t)) l.get(t).delete(f); };
    o.fire = (t) => { for (const f of [...(l.get(t) || [])]) f({ type: t }); };
    o.listeners = (t) => (l.get(t) ? l.get(t).size : 0);
    return o;
  };
  const m = {
    opened: 0, tracks: [], contexts: [], node: null, track: null, sampleRate, deny, permission, constraints: null,
    /** The device delivers these samples now, in blocks. */
    play(samples) {
      for (let at = 0; at < samples.length; at += block) {
        if (m.node && m.node.port.onmessage && m.connected) m.node.port.onmessage({ data: samples.slice(at, at + block) });
      }
    },
  };
  const mediaDevices = events({
    async getUserMedia(constraints) {
      m.constraints = constraints;
      if (m.deny) throw Object.assign(new Error(m.deny), { name: m.deny });
      m.opened++;
      const track = events({ stopped: false, stop() { this.stopped = true; } });
      m.track = track;
      m.tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track] };
    },
  });
  class AudioContext {
    constructor() {
      events(this);
      this.sampleRate = m.sampleRate;
      this.state = 'running';
      this.closed = false;
      this.audioWorklet = { addModule: async (url) => { m.workletUrl = url; } };
      m.contexts.push(this);
    }
    createMediaStreamSource() {
      return { connect: (node) => { m.node = node; m.connected = true; }, disconnect: () => { m.connected = false; } };
    }
    async resume() { this.state = 'running'; }
    async close() { this.closed = true; this.state = 'closed'; }
  }
  class AudioWorkletNode {
    constructor(ctx, name, options) { this.port = { onmessage: null }; this.name = name; this.options = options; }
    disconnect() {}
  }
  m.mediaDevices = mediaDevices;
  m.seams = { mediaDevices, AudioContext, AudioWorkletNode, permissions: { query: async () => ({ state: m.permission }) } };
  return m;
}

/** A page's document and window as event targets, for the visibility tests. */
export function fakePage() {
  const make = () => {
    const l = new Map();
    return {
      addEventListener(t, f) { if (!l.has(t)) l.set(t, new Set()); l.get(t).add(f); },
      removeEventListener(t, f) { if (l.has(t)) l.get(t).delete(f); },
      fire(t) { for (const f of [...(l.get(t) || [])]) f({ type: t }); },
      listeners(t) { return l.get(t) ? l.get(t).size : 0; },
    };
  };
  const document = Object.assign(make(), { visibilityState: 'visible' });
  const window = make();
  return { document, window, hide() { document.visibilityState = 'hidden'; document.fire('visibilitychange'); }, show() { document.visibilityState = 'visible'; document.fire('visibilitychange'); } };
}
