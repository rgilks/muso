class RustDspProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.blockSize = 128;
    this.port.onmessage = (ev) => {
      if (ev.data?.type === "config") {
        this.sampleRate = ev.data.sampleRate;
      } else if (ev.data?.type === "block") {
        const buf = new Float32Array(ev.data.buf);
        this.pending = buf;
      }
    };
    this.pending = null;
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    const ch1 = out[1] || ch0;
    if (!this.pending || this.pending.length < this.blockSize * 2) {
      // Ask main thread to pull from WASM
      this.port.postMessage({ type: "pull", frames: this.blockSize });
      // output silence for this quantum if not ready
      ch0.fill(0);
      ch1.fill(0);
      return true;
    }
    for (let i = 0; i < this.blockSize; i++) {
      ch0[i] = this.pending[i * 2];
      ch1[i] = this.pending[i * 2 + 1];
    }
    this.pending = null;
    return true;
  }
}

registerProcessor("rust-dsp", RustDspProcessor);
