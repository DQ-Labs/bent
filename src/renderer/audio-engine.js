// WebAudio Master Clock, Music Deck, 4-Band FFT Analyzer,
// Waveform Peak Extractor, BPM Estimator & Built-in Electro Breakbeat Synth.

export class AudioDeckEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.gainNode = null;
    this.audioBuffer = null;
    this.sourceNode = null;

    this.isPlaying = false;
    this.loop = true;
    this.startOffset = 0; // seconds into audioBuffer
    this.playStartedAtCtxTime = 0;
    this.duration = 15.0;
    this.bpm = 128;
    this.trackName = 'Built-in 128 BPM Electro Breakbeat Synth';

    this.fftBytes = new Uint8Array(256);
    this.waveformPeaks = new Float32Array(600);
  }

  async ensureContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this.fftBytes = new Uint8Array(this.analyser.frequencyBinCount);

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.85;
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.audioBuffer) {
      await this.loadBuiltInSynthTrack(this.bpm, 8);
    }
  }

  /**
   * Synthesize a punchy 8-bar Electro / Acid Breakbeat AudioBuffer in memory
   * so Perform & Playback modes work out of the box before loading an external audio file.
   */
  async loadBuiltInSynthTrack(bpm = 128, bars = 8) {
    await this.ensureContextOnly();
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    this.bpm = bpm;
    const sampleRate = this.ctx.sampleRate;
    const beatSec = 60 / bpm;
    const barSec = beatSec * 4;
    const totalSec = barSec * bars;
    const totalSamples = Math.floor(totalSec * sampleRate);

    const buffer = this.ctx.createBuffer(2, totalSamples, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const stepSec = beatSec * 0.25; // 1/16th note
    const totalSteps = bars * 16;

    // 16-step breakbeat pattern + acid bassline notes (Hz)
    const kickSteps = new Set([0, 3, 6, 10, 12]);
    const snareSteps = new Set([4, 12, 15]);
    const bassNotes = [55.0, 55.0, 110.0, 65.41, 55.0, 82.41, 73.42, 98.0];

    let prng = 1337;
    const nextNoise = () => {
      prng = (prng * 16807) % 2147483647;
      return (prng / 1073741823.5) - 1.0;
    };

    for (let step = 0; step < totalSteps; step++) {
      const stepInBar = step % 16;
      const startSample = Math.floor(step * stepSec * sampleRate);
      const stepSamples = Math.floor(stepSec * sampleRate);

      const hasKick = kickSteps.has(stepInBar);
      const hasSnare = snareSteps.has(stepInBar);
      const bassFreq = bassNotes[step % bassNotes.length];

      for (let i = 0; i < stepSamples && startSample + i < totalSamples; i++) {
        const t = i / sampleRate;
        let sampleL = 0;
        let sampleR = 0;

        // 1. Punchy 808/909 Sub Kick
        if (hasKick) {
          const kickEnv = Math.exp(-t * 15.0);
          const pitchEnv = 46 + 135 * Math.exp(-t * 42.0);
          const kickSig = Math.sin(2 * Math.PI * pitchEnv * t) * kickEnv * 0.72;
          sampleL += kickSig;
          sampleR += kickSig;
        }

        // 2. Crisp Electro Snare
        if (hasSnare) {
          const snareEnv = Math.exp(-t * 24.0);
          const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 35.0) * 0.35;
          const snap = nextNoise() * snareEnv * 0.42;
          sampleL += body + snap;
          sampleR += body + snap * 0.95;
        }

        // 3. 16th-Note Closed/Open Hi-Hat
        const hatDecay = stepInBar % 4 === 2 ? 18.0 : 52.0;
        const hatEnv = Math.exp(-t * hatDecay);
        const hatSig = nextNoise() * hatEnv * 0.14;
        sampleL += hatSig * 0.85;
        sampleR += hatSig * 1.15;

        // 4. Acid Saw/Square Bassline
        const bassEnv = Math.exp(-t * 9.5);
        const saw = 2 * ((t * bassFreq) - Math.floor(0.5 + t * bassFreq));
        const sub = Math.sin(2 * Math.PI * bassFreq * t);
        const acid = Math.tanh((saw * 0.65 + sub * 0.6) * (1.8 + bassEnv * 2.5)) * bassEnv * 0.34;
        sampleL += acid;
        sampleR += acid;

        left[startSample + i] = Math.max(-0.98, Math.min(0.98, sampleL));
        right[startSample + i] = Math.max(-0.98, Math.min(0.98, sampleR));
      }
    }

    this.audioBuffer = buffer;
    this.duration = Number(buffer.duration.toFixed(4));
    this.trackName = `Built-in ${bpm} BPM Electro Breakbeat (${bars} Bars)`;
    this.startOffset = 0;
    this._computeWaveformPeaks();
    if (wasPlaying) this.play();
    return {
      duration: this.duration,
      bpm: this.bpm,
      name: this.trackName
    };
  }

  async ensureContextOnly() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.72;
      this.fftBytes = new Uint8Array(this.analyser.frequencyBinCount);

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.85;
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
  }

  /**
   * Decode and load an ArrayBuffer from a local audio file (.wav, .mp3, .flac, .ogg).
   */
  async loadAudioArrayBuffer(arrayBuffer, fileName = 'Loaded Track') {
    await this.ensureContextOnly();
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    const decoded = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.audioBuffer = decoded;
    this.duration = Number(decoded.duration.toFixed(4));
    this.trackName = fileName;
    this.startOffset = 0;
    this._computeWaveformPeaks();
    const estimatedBpm = this._estimateBpm();
    if (estimatedBpm) {
      this.bpm = estimatedBpm;
    }

    return {
      duration: this.duration,
      bpm: this.bpm,
      name: this.trackName
    };
  }

  _computeWaveformPeaks(numBuckets = 600) {
    if (!this.audioBuffer) return;
    const ch0 = this.audioBuffer.getChannelData(0);
    const total = ch0.length;
    const step = Math.max(1, Math.floor(total / numBuckets));
    const peaks = new Float32Array(numBuckets);

    for (let b = 0; b < numBuckets; b++) {
      const start = b * step;
      const end = Math.min(total, start + step);
      let max = 0;
      for (let i = start; i < end; i += 4) {
        const v = Math.abs(ch0[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    this.waveformPeaks = peaks;
  }

  _estimateBpm() {
    if (!this.audioBuffer) return 128;
    const ch0 = this.audioBuffer.getChannelData(0);
    const sr = this.audioBuffer.sampleRate;
    // Compute energy envelope in 20ms windows across up to first 30 seconds
    const winSize = Math.floor(sr * 0.02);
    const maxSamples = Math.min(ch0.length, sr * 30);
    const numWins = Math.floor(maxSamples / winSize);
    if (numWins < 40) return 128;

    const env = new Float32Array(numWins);
    for (let w = 0; w < numWins; w++) {
      let sum = 0;
      const base = w * winSize;
      for (let i = 0; i < winSize; i += 4) {
        const s = ch0[base + i];
        sum += s * s;
      }
      env[w] = Math.sqrt(sum / (winSize / 4));
    }

    // Autocorrelate onset differences across 85..170 BPM
    const diffs = new Float32Array(numWins);
    for (let w = 1; w < numWins; w++) {
      diffs[w] = Math.max(0, env[w] - env[w - 1]);
    }

    const winRate = sr / winSize; // ~50 Hz
    let bestBpm = 128;
    let bestScore = -1;
    for (let bpm = 86; bpm <= 168; bpm += 1) {
      const lag = Math.round((60 / bpm) * winRate);
      let score = 0;
      for (let i = lag; i < numWins; i++) {
        score += diffs[i] * diffs[i - lag];
      }
      if (score > bestScore) {
        bestScore = score;
        bestBpm = bpm;
      }
    }
    return bestBpm;
  }

  async play() {
    await this.ensureContext();
    if (this.isPlaying) return;

    this._stopSourceNode();
    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.loop = this.loop;
    src.connect(this.gainNode);

    const offset = ((this.startOffset % this.duration) + this.duration) % this.duration;
    src.start(0, offset);
    this.sourceNode = src;
    this.playStartedAtCtxTime = this.ctx.currentTime - offset;
    this.isPlaying = true;

    src.onended = () => {
      if (this.sourceNode === src && !this.loop) {
        this.isPlaying = false;
        this.startOffset = 0;
      }
    };
  }

  pause() {
    if (!this.isPlaying) return;
    this.startOffset = this.getCurrentTime();
    this._stopSourceNode();
    this.isPlaying = false;
  }

  stop() {
    this._stopSourceNode();
    this.isPlaying = false;
    this.startOffset = 0;
  }

  seek(timeSec) {
    const clamped = Math.max(0, Math.min(this.duration, Number(timeSec) || 0));
    this.startOffset = clamped;
    if (this.isPlaying) {
      this._stopSourceNode();
      this.isPlaying = false;
      this.play();
    }
  }

  getCurrentTime() {
    if (!this.isPlaying || !this.ctx) {
      return this.startOffset;
    }
    const raw = this.ctx.currentTime - this.playStartedAtCtxTime;
    if (this.loop && this.duration > 0) {
      return ((raw % this.duration) + this.duration) % this.duration;
    }
    return Math.min(this.duration, Math.max(0, raw));
  }

  setVolume(val) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, Number(val) || 0));
    }
  }

  /**
   * Return normalized 4-band FFT spectrum energies: { sub, kick, mid, high }.
   */
  getFFTData() {
    if (!this.analyser || !this.isPlaying) {
      return { sub: 0, kick: 0, mid: 0, high: 0 };
    }
    this.analyser.getByteFrequencyData(this.fftBytes);

    const avgRange = (startBin, endBin) => {
      let sum = 0;
      const count = Math.max(1, endBin - startBin);
      for (let i = startBin; i < endBin && i < this.fftBytes.length; i++) {
        sum += this.fftBytes[i];
      }
      return Math.min(1.0, (sum / count) / 235);
    };

    return {
      sub: avgRange(1, 5),
      kick: avgRange(4, 14),
      mid: avgRange(14, 52),
      high: avgRange(52, 140)
    };
  }

  _stopSourceNode() {
    if (this.sourceNode) {
      try {
        this.sourceNode.onended = null;
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch (_e) {
        // Ignore already stopped
      }
      this.sourceNode = null;
    }
  }
}
