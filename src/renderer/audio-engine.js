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
    this.onTrackEnded = null;

    this._playRequestId = 0;
    this.fftBytes = new Uint8Array(1024);
    this.waveformPeaks = new Float32Array(600);
  }

  async ensureContextOnly() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AudioCtx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.74;
      this.fftBytes = new Uint8Array(this.analyser.frequencyBinCount);

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = 0.85;
      this.gainNode.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
  }

  async ensureContext() {
    await this.ensureContextOnly();
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    if (!this.audioBuffer) {
      await this.loadBuiltInSynthTrack(this.bpm, 8);
    }
  }

  /**
   * Synthesize a punchy 8-bar Electro / Acid Breakbeat AudioBuffer in memory
   * using additive voice tails so voices decay smoothly across 1/16th step boundaries.
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

    const kickTailSamples = Math.floor(0.32 * sampleRate);
    const snareTailSamples = Math.floor(0.24 * sampleRate);
    const bassTailSamples = Math.floor(Math.min(0.35, stepSec * 1.45) * sampleRate);

    for (let step = 0; step < totalSteps; step++) {
      const stepInBar = step % 16;
      const startSample = Math.floor(step * stepSec * sampleRate);
      const hasKick = kickSteps.has(stepInBar);
      const hasSnare = snareSteps.has(stepInBar);
      const bassFreq = bassNotes[step % bassNotes.length];

      // 1. Punchy 808/909 Sub Kick with smooth exponential pitch sweep & decay tail
      if (hasKick) {
        let phase = 0;
        const len = Math.min(kickTailSamples, totalSamples - startSample);
        for (let i = 0; i < len; i++) {
          const t = i / sampleRate;
          const env = Math.exp(-t * 14.0) * Math.min(1, i / 24);
          const freq = 46 + 135 * Math.exp(-t * 42.0);
          phase += (2 * Math.PI * freq) / sampleRate;
          const sig = Math.sin(phase) * env * 0.68;
          left[startSample + i] += sig;
          right[startSample + i] += sig;
        }
      }

      // 2. Crisp Electro Snare with full decay tail
      if (hasSnare) {
        const len = Math.min(snareTailSamples, totalSamples - startSample);
        for (let i = 0; i < len; i++) {
          const t = i / sampleRate;
          const attack = Math.min(1, i / 16);
          const snareEnv = Math.exp(-t * 22.0) * attack;
          const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t * 34.0) * 0.34 * attack;
          const snap = nextNoise() * snareEnv * 0.4;
          left[startSample + i] += body + snap;
          right[startSample + i] += body + snap * 0.95;
        }
      }

      // 3. 16th-Note Closed/Open Hi-Hat
      const isOpenHat = stepInBar % 4 === 2;
      const hatDecay = isOpenHat ? 18.0 : 52.0;
      const hatLen = Math.min(Math.floor((isOpenHat ? 0.22 : 0.08) * sampleRate), totalSamples - startSample);
      for (let i = 0; i < hatLen; i++) {
        const t = i / sampleRate;
        const hatEnv = Math.exp(-t * hatDecay) * Math.min(1, i / 12);
        const hatSig = nextNoise() * hatEnv * 0.13;
        left[startSample + i] += hatSig * 0.85;
        right[startSample + i] += hatSig * 1.15;
      }

      // 4. Acid Saw/Square Bassline with short fade-out at tail end
      const bassLen = Math.min(bassTailSamples, totalSamples - startSample);
      const fadeSamples = Math.min(96, Math.floor(bassLen * 0.2));
      for (let i = 0; i < bassLen; i++) {
        const t = i / sampleRate;
        const attack = Math.min(1, i / 24);
        const release = i > bassLen - fadeSamples ? (bassLen - i) / fadeSamples : 1;
        const bassEnv = Math.exp(-t * 9.5) * attack * release;
        const saw = 2 * ((t * bassFreq) - Math.floor(0.5 + t * bassFreq));
        const sub = Math.sin(2 * Math.PI * bassFreq * t);
        const acid = Math.tanh((saw * 0.65 + sub * 0.6) * (1.8 + bassEnv * 2.5)) * bassEnv * 0.32;
        left[startSample + i] += acid;
        right[startSample + i] += acid;
      }
    }

    // Soft-limit master sum cleanly
    for (let i = 0; i < totalSamples; i++) {
      left[i] = Math.tanh(left[i]);
      right[i] = Math.tanh(right[i]);
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

  /**
   * Decode and load an ArrayBuffer from a local audio file (.wav, .mp3, .flac, .ogg).
   */
  async loadAudioArrayBuffer(arrayBuffer, fileName = 'Loaded Track') {
    await this.ensureContextOnly();
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();

    const decoded = await this.ctx.decodeAudioData(arrayBuffer);
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
    // Use 5ms windows (~200 Hz) so every integer BPM 86..168 maps to a distinct lag
    const winSize = Math.max(64, Math.floor(sr * 0.005));
    const maxSamples = Math.min(ch0.length, sr * 30);
    const numWins = Math.floor(maxSamples / winSize);
    if (numWins < 160) return 128;

    const env = new Float32Array(numWins);
    for (let w = 0; w < numWins; w++) {
      let sum = 0;
      const base = w * winSize;
      for (let i = 0; i < winSize; i += 2) {
        const s = ch0[base + i];
        sum += s * s;
      }
      env[w] = Math.sqrt(sum / (winSize / 2));
    }

    // Half-wave rectified onset flux
    const diffs = new Float32Array(numWins);
    for (let w = 1; w < numWins; w++) {
      diffs[w] = Math.max(0, env[w] - env[w - 1]);
    }

    const winRate = sr / winSize;
    let bestBpm = 128;
    let bestScore = -1;
    for (let bpm = 86; bpm <= 168; bpm += 1) {
      const lag = Math.round((60 / bpm) * winRate);
      if (lag <= 0 || lag >= numWins) continue;
      let score = 0;
      const count = numWins - lag;
      for (let i = lag; i < numWins; i++) {
        score += diffs[i] * diffs[i - lag];
      }
      // Normalize by overlap count so shorter lags (higher BPMs) are not favored
      const normalized = score / count;
      if (normalized > bestScore) {
        bestScore = normalized;
        bestBpm = bpm;
      }
    }
    return bestBpm;
  }

  setLoop(enabled) {
    this.loop = Boolean(enabled);
    if (this.sourceNode) {
      this.sourceNode.loop = this.loop;
    }
  }

  _startSourceSync() {
    this._stopSourceNode();
    if (!this.ctx || !this.audioBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.audioBuffer;
    src.loop = this.loop;
    src.connect(this.gainNode);

    const safeDur = Math.max(0.01, this.duration);
    const offset = this.loop
      ? ((this.startOffset % safeDur) + safeDur) % safeDur
      : Math.max(0, Math.min(safeDur - 0.005, this.startOffset));

    src.start(0, offset);
    this.sourceNode = src;
    this.playStartedAtCtxTime = this.ctx.currentTime - offset;
    this.isPlaying = true;

    src.onended = () => {
      if (this.sourceNode === src && !this.loop) {
        this.sourceNode = null;
        this.isPlaying = false;
        this.startOffset = this.duration;
        this.onTrackEnded?.();
      }
    };
  }

  async play() {
    const reqId = ++this._playRequestId;
    await this.ensureContext();
    // Abort if another play/pause/stop/seek superseded this request while awaiting
    if (reqId !== this._playRequestId) return;
    if (this.isPlaying) return;
    this._startSourceSync();
  }

  pause() {
    this._playRequestId++;
    if (!this.isPlaying) return;
    this.startOffset = this.getCurrentTime();
    this._stopSourceNode();
    this.isPlaying = false;
  }

  stop() {
    this._playRequestId++;
    this._stopSourceNode();
    this.isPlaying = false;
    this.startOffset = 0;
  }

  seek(timeSec) {
    const clamped = Math.max(0, Math.min(this.duration, Number(timeSec) || 0));
    this.startOffset = clamped;
    if (this.isPlaying) {
      this._playRequestId++;
      if (this.ctx && this.ctx.state === 'running' && this.audioBuffer) {
        // Synchronous restart eliminates async race conditions during rapid timeline scrubbing
        this._startSourceSync();
      } else {
        this._stopSourceNode();
        this.isPlaying = false;
        this.play();
      }
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
   * Return normalized 4-band FFT spectrum energies derived from sampleRate:
   * sub (20–90 Hz), kick (60–200 Hz), mid (250–2000 Hz), high (2500–12000 Hz).
   */
  getFFTData() {
    if (!this.analyser || !this.ctx || !this.isPlaying) {
      return { sub: 0, kick: 0, mid: 0, high: 0 };
    }
    this.analyser.getByteFrequencyData(this.fftBytes);

    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const maxBin = this.fftBytes.length - 1;
    const avgHzRange = (lowHz, highHz) => {
      const startBin = Math.max(1, Math.floor(lowHz / binHz));
      const endBin = Math.min(maxBin, Math.max(startBin + 1, Math.ceil(highHz / binHz)));
      let sum = 0;
      for (let i = startBin; i < endBin; i++) {
        sum += this.fftBytes[i];
      }
      return Math.min(1.0, (sum / (endBin - startBin)) / 235);
    };

    return {
      sub: avgHzRange(20, 90),
      kick: avgHzRange(60, 200),
      mid: avgHzRange(250, 2000),
      high: avgHzRange(2500, 12000)
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
