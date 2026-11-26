// Spektral gürültü kapısı (AudioWorklet): STFT + uyarlamalı gürültü tabanı tahmini
// Önizlemede ve dışa aktarmada (OfflineAudioContext) aynı işlemci kullanılır.
const N = 1024, HOP = 256, BINS = N / 2 + 1;
const SUBS = 8, SUB_LEN = 34, BIAS = 1.6;

function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
  };
}

class Chan {
  constructor() {
    this.inRing = new Float32Array(N); this.outAcc = new Float32Array(N + HOP);
    this.pos = 0; this.count = 0;
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.smooth = new Float32Array(BINS); this.noise = new Float32Array(BINS); this.gain = new Float32Array(BINS).fill(1);
    // minimum istatistiği: ~1.5 sn'lik pencere, 8 alt pencere
    this.sub = Array.from({ length: SUBS }, () => new Float32Array(BINS).fill(Infinity));
    this.cur = new Float32Array(BINS).fill(Infinity); this.subPos = 0; this.subCount = 0;
    this.frames = 0;
    this.outQ = new Float32Array(N * 2); this.qRead = 0; this.qWrite = 0;
  }
}

class Denoise extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'amount', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }]; }
  constructor() {
    super();
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
    this.chans = [];
  }
  frame(ch, amount) {
    const { re, im, inRing, smooth, noise, gain } = ch;
    for (let i = 0; i < N; i++) { re[i] = inRing[(ch.pos + i) % N] * this.win[i]; im[i] = 0; }
    this.fft(re, im, false);
    const over = 1 + 3 * amount;
    const floor = Math.pow(10, -(6 + 20 * amount) / 20);
    const warm = ch.frames >= N / HOP; // halka tamamen dolana kadar gürültü tahmini yapma
    const endSub = warm && ++ch.subCount >= SUB_LEN;
    for (let k = 0; k < BINS; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      smooth[k] = ch.frames > N / HOP ? 0.8 * smooth[k] + 0.2 * p : p;
      if (warm) {
        if (smooth[k] < ch.cur[k]) ch.cur[k] = smooth[k];
        let mn = ch.cur[k];
        for (let u = 0; u < SUBS; u++) if (ch.sub[u][k] < mn) mn = ch.sub[u][k];
        noise[k] = mn * BIAS;
        if (endSub) { ch.sub[ch.subPos][k] = ch.cur[k]; ch.cur[k] = Infinity; }
      }
      let g = warm ? 1 - (over * noise[k]) / (p + 1e-12) : 1;
      if (g < floor) g = floor;
      // zamansal yumuşatma: müzikal gürültüyü azaltır
      g = g > gain[k] ? 0.5 * gain[k] + 0.5 * g : 0.75 * gain[k] + 0.25 * g;
      gain[k] = g;
      re[k] *= g; im[k] *= g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    }
    if (endSub) { ch.subPos = (ch.subPos + 1) % SUBS; ch.subCount = 0; }
    ch.frames++;
    this.fft(re, im, true);
    // örtüşerek topla (Hann² %75 örtüşmede toplam 1.5)
    const acc = ch.outAcc;
    for (let i = 0; i < N; i++) acc[i] += (re[i] / N) * this.win[i] / 1.5;
    // ilk HOP örnek hazır
    for (let i = 0; i < HOP; i++) { ch.outQ[ch.qWrite % ch.outQ.length] = acc[i]; ch.qWrite++; }
    acc.copyWithin(0, HOP); acc.fill(0, N);
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const amount = params.amount[0];
    for (let c = 0; c < output.length; c++) {
      const inp = input[c] || input[0];
      const out = output[c];
      if (!this.chans[c]) this.chans[c] = new Chan();
      const ch = this.chans[c];
      for (let i = 0; i < out.length; i++) {
        ch.inRing[ch.pos] = inp ? inp[i] : 0;
        ch.pos = (ch.pos + 1) % N;
        ch.count++;
        if (ch.count >= HOP) { ch.count = 0; this.frame(ch, amount); }
        out[i] = ch.qRead < ch.qWrite ? ch.outQ[ch.qRead++ % ch.outQ.length] : 0;
      }
    }
    return true;
  }
}
registerProcessor('kurgu-denoise', Denoise);
