"use client";
import { useEffect, useRef, useState } from "react";

export default function ClientAmbient() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [started, setStarted] = useState(false);
  const mixRef = useRef<HTMLInputElement | null>(null);
  const widthRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const cleanupListenersRef = useRef<null | (() => void)>(null);
  const dspRef = useRef<any>(null);

  useEffect(() => {
    return () => {
      stop();
    };
  }, []);

  async function start() {
    if (started) return;
    const audioCtx = new AudioContext({ sampleRate: 48_000 });
    audioCtxRef.current = audioCtx;

    const dspUrl = new URL("/dsp/dsp.js", window.location.origin).toString();
    const dsp = await import(/* webpackIgnore: true */ dspUrl);
    dspRef.current = dsp;
    await dsp.default("/dsp/dsp_bg.wasm");
    dsp.init_engine(audioCtx.sampleRate);

    await audioCtx.audioWorklet.addModule("/worklet/processor.js");
    const node = new AudioWorkletNode(audioCtx, "rust-dsp", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    nodeRef.current = node;
    node.port.postMessage({ type: "config", sampleRate: audioCtx.sampleRate });
    node.port.onmessage = (ev) => {
      if (ev.data?.type === "pull") {
        const frames = ev.data.frames as number;
        const buf = new Float32Array(frames * 2);
        dsp.render_into(buf);
        node.port.postMessage({ type: "block", buf }, [buf.buffer]);
      }
    };

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;
    node.connect(analyser);
    analyser.connect(audioCtx.destination);

    const update = () =>
      dspRef.current?.set_reverb(
        parseFloat(mixRef.current!.value),
        parseFloat(widthRef.current!.value)
      );
    update();
    const mixEl = mixRef.current!;
    const widthEl = widthRef.current!;
    mixEl.addEventListener("input", update);
    widthEl.addEventListener("input", update);
    cleanupListenersRef.current = () => {
      mixEl.removeEventListener("input", update);
      widthEl.removeEventListener("input", update);
    };

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const loop = () => {
      const analyserNode = analyserRef.current;
      if (!analyserNode) return;
      const spectrum = new Uint8Array(analyserNode.frequencyBinCount);
      analyserNode.getByteFrequencyData(spectrum);
      ctx.fillStyle = "#0b0b0f";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#6cf";
      const bins = 128;
      const w = canvas.width / bins;
      for (let i = 0; i < bins; i++) {
        const start = Math.floor((i * spectrum.length) / bins);
        const end = Math.floor(((i + 1) * spectrum.length) / bins);
        let sum = 0;
        for (let j = start; j < end; j++) sum += spectrum[j];
        const v = sum / Math.max(1, end - start) / 255;
        const h = v * canvas.height;
        ctx.fillRect(i * w, canvas.height - h, w - 1, h);
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    await audioCtx.resume();
    setStarted(true);
  }

  function stop() {
    if (!started && !audioCtxRef.current) return;
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    try {
      nodeRef.current?.disconnect();
      analyserRef.current?.disconnect();
    } catch {}
    audioCtxRef.current?.close().catch(() => {});
    nodeRef.current = null;
    analyserRef.current = null;
    audioCtxRef.current = null;
    setStarted(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <button
          className="border border-[#2a3a55] bg-[#0f1420] text-[#cfe3ff] py-2 px-4 rounded-lg"
          onClick={() => (started ? stop() : start())}
        >
          {started ? "Stop" : "Start"}
        </button>
        <label className="flex items-center gap-2 text-[#a9bedc]">
          Mix{" "}
          <input
            ref={mixRef}
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.55"
          />
        </label>
        <label className="flex items-center gap-2 text-[#a9bedc]">
          Width{" "}
          <input
            ref={widthRef}
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.9"
          />
        </label>
      </div>
      <canvas
        ref={canvasRef}
        width={1024}
        height={256}
        className="w-full rounded-xl bg-[#0b0b0f]"
      />
    </div>
  );
}
