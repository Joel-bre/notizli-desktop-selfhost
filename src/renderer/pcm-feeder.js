/**
 * AudioWorklet that plays PCM pushed from the Windows meeting-audio helper
 * (mono Float32 at the context's 48 kHz) into the Web Audio graph, where it
 * becomes channel 1 of the recording.
 *
 * The helper delivers audio in bursts over IPC, so a small jitter buffer sits
 * in front of the output: playback (re)starts once PREBUFFER is queued, and the
 * queue is trimmed to MAX_QUEUED so latency cannot grow over a long meeting.
 * Underruns output silence — a quiet meeting simply has no packets.
 */
const PREBUFFER = 0.06; // seconds
const MAX_QUEUED = 0.5; // seconds

class PcmFeeder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunks = [];
    this.offset = 0; // read position inside chunks[0]
    this.queued = 0; // samples not yet played
    this.playing = false;
    this.port.onmessage = (e) => {
      const chunk = e.data;
      if (!(chunk instanceof Float32Array) || chunk.length === 0) return;
      this.chunks.push(chunk);
      this.queued += chunk.length;
      const max = sampleRate * MAX_QUEUED;
      while (this.queued > max && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.queued -= dropped.length - this.offset;
        this.offset = 0;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.playing && this.queued >= sampleRate * PREBUFFER) this.playing = true;
    let i = 0;
    if (this.playing) {
      while (i < out.length && this.chunks.length) {
        const head = this.chunks[0];
        const n = Math.min(out.length - i, head.length - this.offset);
        out.set(head.subarray(this.offset, this.offset + n), i);
        i += n;
        this.offset += n;
        this.queued -= n;
        if (this.offset >= head.length) {
          this.chunks.shift();
          this.offset = 0;
        }
      }
      if (i < out.length) this.playing = false; // ran dry: rebuffer before resuming
    }
    out.fill(0, i);
    return true;
  }
}

registerProcessor("pcm-feeder", PcmFeeder);
