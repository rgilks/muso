use wasm_bindgen::prelude::*;

const BLOCK_SIZE_DEFAULT: usize = 128; // AudioWorklet block

#[inline]
fn tanh_fast(x: f32) -> f32 {
    // Good sounding soft clipper
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}

struct OnePoleLpf {
    a: f32,
    b: f32,
    z: f32,
}

impl OnePoleLpf {
    fn new(sample_rate: f32, cutoff_hz: f32) -> Self {
        let x = (-2.0 * core::f32::consts::PI * cutoff_hz / sample_rate).exp();
        let a = 1.0 - x;
        let b = x;
        Self { a, b, z: 0.0 }
    }
    fn set_cutoff(&mut self, sample_rate: f32, cutoff_hz: f32) {
        let x = (-2.0 * core::f32::consts::PI * cutoff_hz / sample_rate).exp();
        self.a = 1.0 - x;
        self.b = x;
    }
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        self.z = self.a * input + self.b * self.z;
        self.z
    }
}

struct Delay {
    buf: Vec<f32>,
    write_idx: usize,
}

impl Delay {
    fn with_ms(sample_rate: f32, ms: f32) -> Self {
        let len = (ms * 0.001 * sample_rate).round().max(1.0) as usize;
        Self {
            buf: vec![0.0; len],
            write_idx: 0,
        }
    }
    #[inline]
    fn read_frac(&self, frac_idx: f32) -> f32 {
        // Linear fractional read from circular buffer. frac_idx is delay length in samples.
        let len = self.buf.len();
        let wi = self.write_idx as isize;
        let di = frac_idx.floor() as isize;
        let frac = frac_idx - di as f32;
        let i0 = ((wi - di - 1).rem_euclid(len as isize)) as usize;
        let i1 = ((i0 + 1) % len) as usize;
        let s0 = self.buf[i0];
        let s1 = self.buf[i1];
        s0 + (s1 - s0) * frac
    }
    #[inline]
    fn write(&mut self, sample: f32) {
        self.buf[self.write_idx] = sample;
        self.write_idx += 1;
        if self.write_idx >= self.buf.len() {
            self.write_idx = 0;
        }
    }
}

struct CombLpf {
    delay: Delay,
    feedback: f32,
    damp: OnePoleLpf,
    base_samps: f32,
    lfo_phase: f32,
    lfo_inc: f32,
}

impl CombLpf {
    fn new(
        sample_rate: f32,
        ms: f32,
        feedback: f32,
        damp_hz: f32,
        lfo_rate_hz: f32,
        lfo_width_samps: f32,
    ) -> Self {
        let delay = Delay::with_ms(sample_rate, ms);
        let damp = OnePoleLpf::new(sample_rate, damp_hz);
        let base_samps = ms * 0.001 * sample_rate;
        let lfo_inc = lfo_rate_hz / sample_rate;
        Self {
            delay,
            feedback,
            damp,
            base_samps,
            lfo_phase: 0.0,
            lfo_inc: lfo_inc * core::f32::consts::TAU * 0.5 * (lfo_width_samps / sample_rate),
        }
    }
    #[inline]
    fn process(&mut self, input: f32, sample_rate: f32) -> f32 {
        // Gentle modulation of delay length to avoid metallic ringing
        let mod_depth = 0.001 * sample_rate; // ~1ms max
        let lfo = (self.lfo_phase).sin();
        self.lfo_phase = (self.lfo_phase + self.lfo_inc).fract();
        let frac = (self.base_samps + lfo * mod_depth).max(1.0);
        let y = self.delay.read_frac(frac);
        let fb = self.damp.process(y) * self.feedback;
        self.delay.write(input + fb);
        y
    }
}

struct Allpass {
    delay: Delay,
    g: f32,
    base_samps: f32,
}

impl Allpass {
    fn new(sample_rate: f32, ms: f32, g: f32) -> Self {
        let delay = Delay::with_ms(sample_rate, ms);
        let base_samps = ms * 0.001 * sample_rate;
        Self {
            delay,
            g,
            base_samps,
        }
    }
    #[inline]
    fn process(&mut self, input: f32) -> f32 {
        let y = self.delay.read_frac(self.base_samps);
        let x = input + (-self.g) * y;
        self.delay.write(x);
        y + self.g * x
    }
}

struct FreeverbStereo {
    sample_rate: f32,
    comb_l: Vec<CombLpf>,
    comb_r: Vec<CombLpf>,
    ap_l: Vec<Allpass>,
    ap_r: Vec<Allpass>,
    wet: f32,
    width: f32,
}

impl FreeverbStereo {
    fn new(sample_rate: f32) -> Self {
        // Tuned delays (ms) roughly based on Freeverb but adjusted
        let comb_ms = [50.3, 56.7, 61.1, 68.3, 73.1, 79.9, 86.7, 90.1];
        let comb_ms_r = [53.1, 59.3, 63.7, 70.9, 75.9, 82.7, 88.3, 93.7];
        let ap_ms = [5.1, 1.7, 3.5];
        let ap_ms_r = [5.8, 2.2, 4.1];
        let feedback = 0.82; // long tail
        let damp_hz = 4800.0; // high-frequency damping
        let lfo_rate = 0.13; // slow modulation
        let lfo_width_samps = 0.0; // using separate mod_depth above; keep 0 here
        let comb_l = comb_ms
            .iter()
            .map(|&ms| {
                CombLpf::new(
                    sample_rate,
                    ms,
                    feedback,
                    damp_hz,
                    lfo_rate,
                    lfo_width_samps,
                )
            })
            .collect();
        let comb_r = comb_ms_r
            .iter()
            .map(|&ms| {
                CombLpf::new(
                    sample_rate,
                    ms,
                    feedback,
                    damp_hz,
                    lfo_rate,
                    lfo_width_samps,
                )
            })
            .collect();
        let ap_l = ap_ms
            .iter()
            .map(|&ms| Allpass::new(sample_rate, ms, 0.53))
            .collect();
        let ap_r = ap_ms_r
            .iter()
            .map(|&ms| Allpass::new(sample_rate, ms, 0.53))
            .collect();
        Self {
            sample_rate,
            comb_l,
            comb_r,
            ap_l,
            ap_r,
            wet: 0.5,
            width: 0.9,
        }
    }
    fn set_mix(&mut self, wet: f32, width: f32) {
        self.wet = wet.clamp(0.0, 1.0);
        self.width = width.clamp(0.0, 1.0);
    }
    fn randomize(&mut self) {
        let frand = || js_sys::Math::random() as f32;
        let rr = |mn: f32, mx: f32| mn + frand() * (mx - mn);
        // Randomize comb feedback, damping cutoff and base delay factors
        for c in &mut self.comb_l {
            c.feedback = rr(0.68, 0.9);
            c.damp.set_cutoff(self.sample_rate, rr(900.0, 9000.0));
            c.base_samps = (c.base_samps * rr(0.85, 1.2)).max(1.0);
        }
        for c in &mut self.comb_r {
            c.feedback = rr(0.68, 0.9);
            c.damp.set_cutoff(self.sample_rate, rr(900.0, 9000.0));
            c.base_samps = (c.base_samps * rr(0.85, 1.2)).max(1.0);
        }
    }
    #[inline]
    fn process(&mut self, input_l: f32, input_r: f32) -> (f32, f32) {
        let mut acc_l = 0.0;
        let mut acc_r = 0.0;
        for c in &mut self.comb_l {
            acc_l += c.process(input_l, self.sample_rate);
        }
        for c in &mut self.comb_r {
            acc_r += c.process(input_r, self.sample_rate);
        }
        acc_l *= 1.0 / (self.comb_l.len() as f32);
        acc_r *= 1.0 / (self.comb_r.len() as f32);
        for a in &mut self.ap_l {
            acc_l = a.process(acc_l);
        }
        for a in &mut self.ap_r {
            acc_r = a.process(acc_r);
        }
        let wet1 = self.wet * (self.width * 0.5 + 0.5);
        let wet2 = self.wet * ((1.0 - self.width) * 0.5);
        (acc_l * wet1 + acc_r * wet2, acc_r * wet1 + acc_l * wet2)
    }
}

struct Lfo {
    phase: f32,
    inc: f32,
}
impl Lfo {
    fn new(freq: f32, sr: f32) -> Self {
        Self {
            phase: 0.0,
            inc: freq / sr,
        }
    }
    fn set_freq(&mut self, freq: f32, sr: f32) {
        self.inc = freq / sr;
    }
    #[inline]
    fn next(&mut self) -> f32 {
        let v = (self.phase * core::f32::consts::TAU).sin();
        self.phase = (self.phase + self.inc) % 1.0;
        v
    }
}

struct DroneOsc {
    freq: f32,
    phase: f32,
    lfo: Lfo,
}
impl DroneOsc {
    fn new(freq: f32, sr: f32) -> Self {
        Self {
            freq,
            phase: 0.0,
            lfo: Lfo::new(0.03, sr),
        }
    }
    #[inline]
    fn next(&mut self, sr: f32) -> f32 {
        // Slow wander
        let drift = self.lfo.next() * 0.2;
        self.freq *= (1.0 + drift * 0.0005);
        self.phase = (self.phase + self.freq / sr) % 1.0;
        (self.phase * core::f32::consts::TAU).sin()
    }
}

struct PinkNoise {
    b0: f32,
    b1: f32,
    b2: f32,
}
impl PinkNoise {
    fn new() -> Self {
        Self {
            b0: 0.0,
            b1: 0.0,
            b2: 0.0,
        }
    }
    #[inline]
    fn next(&mut self, white: f32) -> f32 {
        // Paul Kellet filter
        self.b0 = 0.99765 * self.b0 + white * 0.0990460;
        self.b1 = 0.96300 * self.b1 + white * 0.2965164;
        self.b2 = 0.57000 * self.b2 + white * 1.0526913;
        self.b0 + self.b1 + self.b2 + white * 0.1848
    }
}

struct Engine {
    sample_rate: f32,
    reverb: FreeverbStereo,
    drones: [DroneOsc; 4],
    noise: PinkNoise,
    noise_filter: OnePoleLpf,
    pan_lfo: Lfo,
    out: Vec<f32>, // interleaved stereo
}

impl Engine {
    fn new(sample_rate: f32) -> Self {
        let base = 55.0; // low drone base
        let ratios = [1.0, 5.0 / 4.0, 3.0 / 2.0, 2.0];
        let drones = [
            DroneOsc::new(base * ratios[0], sample_rate),
            DroneOsc::new(base * ratios[1], sample_rate),
            DroneOsc::new(base * ratios[2], sample_rate),
            DroneOsc::new(base * ratios[3], sample_rate),
        ];
        Self {
            sample_rate,
            reverb: FreeverbStereo::new(sample_rate),
            drones,
            noise: PinkNoise::new(),
            noise_filter: OnePoleLpf::new(sample_rate, 1200.0),
            pan_lfo: Lfo::new(0.011, sample_rate),
            out: vec![0.0; BLOCK_SIZE_DEFAULT * 2],
        }
    }

    fn randomize(&mut self) {
        let frand = || js_sys::Math::random() as f32;
        let rr = |mn: f32, mx: f32| mn + frand() * (mx - mn);
        // Randomize drone fundamentals within musical-ish ranges
        let base = rr(40.0, 110.0);
        let ratios = [1.0, 5.0 / 4.0, 3.0 / 2.0, 2.0];
        for (i, d) in self.drones.iter_mut().enumerate() {
            d.freq = base * ratios[i] * rr(0.95, 1.08);
        }
        // Randomize noise filter cutoff
        self.noise_filter
            .set_cutoff(self.sample_rate, rr(600.0, 6000.0));
        // Randomize pan LFO speed
        self.pan_lfo.set_freq(rr(0.005, 0.05), self.sample_rate);
        // Randomize reverb internals
        self.reverb.randomize();
    }

    fn render(&mut self, frames: usize) -> *const f32 {
        if self.out.len() < frames * 2 {
            self.out.resize(frames * 2, 0.0);
        }

        for n in 0..frames {
            // Sources
            let mut s = 0.0;
            for d in &mut self.drones {
                s += d.next(self.sample_rate) * 0.18;
            }
            // Gentle colored noise bed
            let white = js_sys::Math::random() as f32 * 2.0 - 1.0;
            let pn = self.noise.next(white);
            s += self.noise_filter.process(pn) * 0.06;
            s = tanh_fast(s * 1.6);

            // Autopan
            let p = (self.pan_lfo.next() * 0.5 + 0.5).clamp(0.0, 1.0);
            let dry_l = s * (1.0 - p);
            let dry_r = s * p;

            // Reverb
            let (wet_l, wet_r) = self.reverb.process(s, s);
            let l = dry_l * 0.4 + wet_l;
            let r = dry_r * 0.4 + wet_r;

            self.out[n * 2] = l;
            self.out[n * 2 + 1] = r;
        }

        self.out.as_ptr()
    }
}

thread_local! {
    static ENGINE: core::cell::RefCell<Option<Engine>> = core::cell::RefCell::new(None);
}

#[wasm_bindgen]
pub fn init_engine(sample_rate: f32) {
    ENGINE.with(|e| {
        *e.borrow_mut() = Some(Engine::new(sample_rate));
    });
}

#[wasm_bindgen]
pub fn set_reverb(wet: f32, width: f32) {
    ENGINE.with(|e| {
        if let Some(ref mut eng) = *e.borrow_mut() {
            eng.reverb.set_mix(wet, width);
        }
    });
}

#[wasm_bindgen]
pub fn randomize() {
    ENGINE.with(|e| {
        if let Some(ref mut eng) = *e.borrow_mut() {
            eng.randomize();
        }
    });
}

#[wasm_bindgen]
pub fn render(frames: usize) -> *const f32 {
    ENGINE.with(|e| {
        if let Some(ref mut eng) = *e.borrow_mut() {
            eng.render(frames)
        } else {
            core::ptr::null()
        }
    })
}

#[wasm_bindgen]
pub fn render_into(out: &mut [f32]) {
    ENGINE.with(|e| {
        if let Some(ref mut eng) = *e.borrow_mut() {
            let frames = out.len() / 2;
            let ptr = eng.render(frames);
            if !ptr.is_null() {
                // Safety: ptr points to at least frames*2 f32 values owned by engine.out
                let src = unsafe { core::slice::from_raw_parts(ptr, frames * 2) };
                out[..frames * 2].copy_from_slice(src);
            }
        }
    });
}
