"use client";
import { useEffect, useRef, useState } from "react";

type DspModule = {
  default: (moduleOrPath?: unknown) => Promise<unknown>;
  init_engine: (sampleRate: number) => void;
  set_reverb: (wet: number, width: number) => void;
  render_into: (out: Float32Array) => void;
};

export default function ClientAmbient() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [started, setStarted] = useState(false);
  const mixRef = useRef<HTMLInputElement | null>(null);
  const widthRef = useRef<HTMLInputElement | null>(null);
  const volumeRef = useRef<HTMLInputElement | null>(null);
  const cutoffRef = useRef<HTMLInputElement | null>(null);
  const resonanceRef = useRef<HTMLInputElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const lpfRef = useRef<BiquadFilterNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const cleanupListenersRef = useRef<null | (() => void)>(null);
  const dspRef = useRef<DspModule | null>(null);
  const noiseTexRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount without depending on external functions
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      cleanupListenersRef.current?.();
      try {
        nodeRef.current?.disconnect();
        analyserRef.current?.disconnect();
      } catch {}
      audioCtxRef.current?.close().catch(() => {});
      nodeRef.current = null;
      analyserRef.current = null;
      audioCtxRef.current = null;
    };
  }, []);

  async function start() {
    if (started) return;
    const audioCtx = new AudioContext({ sampleRate: 48_000 });
    audioCtxRef.current = audioCtx;

    const dspUrl = new URL("/dsp/dsp.js", window.location.origin).toString();
    const dsp = await import(/* webpackIgnore: true */ dspUrl);
    dspRef.current = dsp as DspModule;
    await (dspRef.current as DspModule).default("/dsp/dsp_bg.wasm");
    dspRef.current.init_engine(audioCtx.sampleRate);

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
        dspRef.current?.render_into(buf);
        node.port.postMessage({ type: "block", buf }, [buf.buffer]);
      }
    };

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyserRef.current = analyser;
    node.connect(analyser);
    // Low-pass filter with resonance (post-analyser so viz stays full-band)
    const lpf = audioCtx.createBiquadFilter();
    lpf.type = "lowpass";
    const initCut = cutoffRef.current
      ? parseFloat(cutoffRef.current.value)
      : 6000;
    const initQ = resonanceRef.current
      ? parseFloat(resonanceRef.current.value)
      : 0.7;
    lpf.frequency.value = isFinite(initCut) ? initCut : 6000;
    lpf.Q.value = isFinite(initQ) ? initQ : 0.7;
    lpfRef.current = lpf;
    // Volume control after LPF
    const gain = audioCtx.createGain();
    gainRef.current = gain;
    const vol = volumeRef.current ? parseFloat(volumeRef.current.value) : 0.8;
    gain.gain.value = isFinite(vol) ? vol : 0.8;
    analyser.connect(lpf);
    lpf.connect(gain);
    gain.connect(audioCtx.destination);

    const update = () =>
      dspRef.current!.set_reverb(
        parseFloat(mixRef.current!.value),
        parseFloat(widthRef.current!.value)
      );
    update();
    const mixEl = mixRef.current!;
    const widthEl = widthRef.current!;
    const volumeEl = volumeRef.current!;
    const cutoffEl = cutoffRef.current!;
    const resonanceEl = resonanceRef.current!;
    mixEl.addEventListener("input", update);
    widthEl.addEventListener("input", update);
    const updateVolume = () => {
      if (gainRef.current && volumeRef.current) {
        const v = parseFloat(volumeRef.current.value);
        gainRef.current.gain.value = isFinite(v)
          ? v
          : gainRef.current.gain.value;
      }
    };
    const updateCutoff = () => {
      if (lpfRef.current && cutoffRef.current && audioCtxRef.current) {
        const v = parseFloat(cutoffRef.current.value);
        lpfRef.current.frequency.setTargetAtTime(
          Math.max(
            20,
            Math.min(20000, isFinite(v) ? v : lpfRef.current.frequency.value)
          ),
          audioCtxRef.current.currentTime,
          0.01
        );
      }
    };
    const updateResonance = () => {
      if (lpfRef.current && resonanceRef.current && audioCtxRef.current) {
        const v = parseFloat(resonanceRef.current.value);
        lpfRef.current.Q.setTargetAtTime(
          Math.max(0.0001, isFinite(v) ? v : lpfRef.current.Q.value),
          audioCtxRef.current.currentTime,
          0.01
        );
      }
    };
    volumeEl.addEventListener("input", updateVolume);
    cutoffEl.addEventListener("input", updateCutoff);
    resonanceEl.addEventListener("input", updateResonance);
    cleanupListenersRef.current = () => {
      mixEl.removeEventListener("input", update);
      widthEl.removeEventListener("input", update);
      volumeEl.removeEventListener("input", updateVolume);
      cutoffEl.removeEventListener("input", updateCutoff);
      resonanceEl.removeEventListener("input", updateResonance);
    };

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    // Responsive canvas sizing with device pixel ratio
    const resizeCanvas = () => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const rect = canvas.getBoundingClientRect();
      const viewW = Math.max(300, Math.round(rect.width));
      const viewH = Math.max(160, Math.min(480, Math.round(viewW * 0.28)));
      canvas.style.height = `${viewH}px`;
      canvas.width = Math.floor(viewW * dpr);
      canvas.height = Math.floor(viewH * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };
    resizeCanvas();
    const onResize = () => resizeCanvas();
    window.addEventListener("resize", onResize);

    // Prepare a small noise texture for cheap film grain/static
    const noise = document.createElement("canvas");
    noise.width = 256;
    noise.height = 256;
    const nctx = noise.getContext("2d")!;
    const nimg = nctx.createImageData(noise.width, noise.height);
    for (let i = 0; i < nimg.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      nimg.data[i + 0] = 0; // R
      nimg.data[i + 1] = v; // G (terminal green bias)
      nimg.data[i + 2] = 0; // B
      nimg.data[i + 3] = v > 200 ? 20 : 12; // sparse specks
    }
    nctx.putImageData(nimg, 0, 0);
    noiseTexRef.current = noise;
    const loop = () => {
      const analyserNode = analyserRef.current;
      if (!analyserNode) return;
      const spectrum = new Uint8Array(analyserNode.frequencyBinCount);
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const W = canvas.width / dpr;
      const H = canvas.height / dpr;
      analyserNode.getByteFrequencyData(spectrum);
      // Background and subtle vignette
      ctx.fillStyle = "#070a12";
      ctx.fillRect(0, 0, W, H);
      const grdV = ctx.createRadialGradient(
        W * 0.5,
        H * 0.5,
        Math.min(W, H) * 0.1,
        W * 0.5,
        H * 0.5,
        Math.max(W, H) * 0.7
      );
      grdV.addColorStop(0, "rgba(0,255,120,0.02)");
      grdV.addColorStop(1, "rgba(0,0,0,0.35)");
      ctx.fillStyle = grdV;
      ctx.fillRect(0, 0, W, H);

      const bins = 128;
      const w = W / bins;
      // Bar gradient in terminal green hues
      const barGrad = ctx.createLinearGradient(0, H, 0, 0);
      barGrad.addColorStop(0, "#093");
      barGrad.addColorStop(1, "#0f8");
      ctx.fillStyle = barGrad;

      for (let i = 0; i < bins; i++) {
        const start = Math.floor((i * spectrum.length) / bins);
        const end = Math.floor(((i + 1) * spectrum.length) / bins);
        let sum = 0;
        for (let j = start; j < end; j++) sum += spectrum[j];
        // slight jitter for glitchiness
        const v =
          (sum / Math.max(1, end - start) / 255) *
          (1.0 + (Math.random() - 0.5) * 0.06);
        const h = Math.max(0, Math.min(H, v * H));
        const jitter = (Math.random() - 0.5) * 0.8;
        ctx.fillRect(i * w + jitter, H - h, Math.max(1, w - 1), h);
      }

      // Scanlines
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = "#00ff88";
      for (let y = 0; y < H; y += 2) {
        ctx.fillRect(0, y, W, 1);
      }
      ctx.globalAlpha = 1;

      // Occasional glitch slices (copy/shift rows)
      if (Math.random() < 0.08) {
        const slices = 1 + Math.floor(Math.random() * 3);
        for (let s = 0; s < slices; s++) {
          const sy = Math.random() * H;
          const sh = 4 + Math.random() * 20;
          const sx = 0;
          const sw = W;
          const dx = (Math.random() - 0.5) * 12;
          ctx.globalCompositeOperation = "lighter";
          ctx.drawImage(canvas, sx, sy, sw, sh, dx, sy, sw, sh);
          ctx.globalCompositeOperation = "source-over";
        }
      }

      // Grain/static overlay
      if (noiseTexRef.current) {
        ctx.globalAlpha = 0.08 + Math.random() * 0.05;
        const nx = Math.random() * (noiseTexRef.current.width - 1);
        const ny = Math.random() * (noiseTexRef.current.height - 1);
        ctx.drawImage(
          noiseTexRef.current,
          nx,
          ny,
          noiseTexRef.current.width - nx,
          noiseTexRef.current.height - ny,
          0,
          0,
          W,
          H
        );
        ctx.globalAlpha = 1;
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
    window.removeEventListener("resize", () => {});
    cleanupListenersRef.current?.();
    cleanupListenersRef.current = null;
    try {
      nodeRef.current?.disconnect();
      analyserRef.current?.disconnect();
      lpfRef.current?.disconnect();
      gainRef.current?.disconnect();
    } catch {}
    audioCtxRef.current?.close().catch(() => {});
    nodeRef.current = null;
    analyserRef.current = null;
    lpfRef.current = null;
    gainRef.current = null;
    audioCtxRef.current = null;
    setStarted(false);
  }

  return (
    <div className="space-y-4">
      <div className="neon-panel flex flex-wrap items-center gap-3 sm:gap-4">
        <button
          className="border border-cyan-400/60 bg-[#0a0f1f]/80 text-cyan-100 py-2 px-5 rounded-lg shadow-[0_0_12px_#00eaff66]
                     hover:bg-[#0f1a2f]/80 hover:shadow-[0_0_18px_#00eaffaa] transition w-full sm:w-auto"
          onClick={() => (started ? stop() : start())}
        >
          {started ? "Stop" : "Start"}
        </button>
        <label className="flex items-center gap-2 text-cyan-200 w-full sm:w-auto">
          Mix{" "}
          <input
            ref={mixRef}
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.55"
            className="slider-neon w-full sm:w-[200px]"
          />
        </label>
        <label className="flex items-center gap-2 text-lime-200 w-full sm:w-auto">
          LPF
          <input
            ref={cutoffRef}
            type="range"
            min="20"
            max="20000"
            step="1"
            defaultValue="6000"
            className="slider-neon accent-lime-400 w-full sm:w-[220px]"
          />
        </label>
        <label className="flex items-center gap-2 text-lime-200 w-full sm:w-auto">
          Res
          <input
            ref={resonanceRef}
            type="range"
            min="0"
            max="24"
            step="0.01"
            defaultValue="0.7"
            className="slider-neon accent-lime-500 w-full sm:w-[200px]"
          />
        </label>
        <label className="flex items-center gap-2 text-cyan-200 w-full sm:w-auto">
          Width{" "}
          <input
            ref={widthRef}
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.9"
            className="slider-neon w-full sm:w-[200px]"
          />
        </label>
        <label className="flex items-center gap-2 text-pink-200 w-full sm:w-auto">
          Volume
          <input
            ref={volumeRef}
            type="range"
            min="0"
            max="1"
            step="0.01"
            defaultValue="0.8"
            className="slider-neon accent-pink-500 w-full sm:w-[200px]"
          />
        </label>
      </div>
      <canvas
        ref={canvasRef}
        width={1024}
        height={256}
        className="w-full rounded-xl bg-[#070a12] shadow-[0_0_24px_#00eaff44,0_0_48px_#ff00ff22] border border-white/10"
      />
    </div>
  );
}
