// BENT // Main Workstation Application Controller
// Connects EDIT, PERFORM, and PLAYBACK modes with the WebGL2 Circuit-Bend Shader Engine,
// WebAudio Music Deck, Traktor Kontrol F1 Hardware Controller, and FL Studio-style Piano Roll.

import {
  CANVAS_PRESETS,
  GLOBAL_MACROS,
  createDefaultProject,
  validateAndNormalizeProject
} from '../shared/project-schema.js';

import {
  gridDivisionToSeconds,
  computeDeterministicClipTime,
  evaluateTimelineAt,
  PerformanceRecorder
} from '../shared/timeline-engine.js';

import { WebGLVideoBender } from './webgl-bender.js';
import { AudioDeckEngine } from './audio-engine.js';
import { F1HardwareController } from './f1-hardware-ui.js';
import { PianoRollTimelineUI } from './piano-roll-ui.js';

class BentWorkstationApp {
  constructor() {
    this.project = createDefaultProject();
    this.currentProjectPath = null;
    this.mode = 'edit'; // 'edit' | 'perform' | 'playback'

    // Live state for Edit & Perform modes
    this.selectedPadIndex = 0;
    this.activeClipPadIndex = 0;
    this.activeClipTriggeredAt = 0;
    this.activeFxPads = new Set();
    this.liveReverseHeld = false;
    this.liveQuantizeEnabled = false;
    this.liveStutterDivision = 'off'; // 'off' | '1/4' | '1/8' | '1/16' | '1/32'
    this.stutterAnchorClipTime = 0;

    // Recording & Overdub state
    this.isRecordingTake = false;
    this.activeRecorder = null;
    this.isOverdubbing = false;

    // Scrubbing state for Playback mode
    this.isScrubbingTimeline = false;
    this.scrubTimestamp = 0;

    this._initEngines();
    this._initModeUI();
    this._initEditModeControls();
    this._initPerformModeControls();
    this._initPlaybackModeControls();
    this._initTransportAndProjectControls();

    this.syncAllUIFromProject();
    this._startRenderLoop();
  }

  _initEngines() {
    const glCanvas = document.getElementById('bent-webgl-canvas');
    this.bender = new WebGLVideoBender(glCanvas);

    this.audio = new AudioDeckEngine();
    // Pre-generate the built-in 128 BPM 8-bar synth breakbeat track asynchronously
    this.audio.loadBuiltInSynthTrack(this.project.audio.bpm, 8).then(() => {
      this._drawPerformWaveform();
      this.pianoRoll?.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
    });

    const f1Container = document.getElementById('f1-hardware-dock');
    this.f1 = new F1HardwareController(f1Container, {
      onPadDown: (padIndex) => this.handleF1PadDown(padIndex),
      onPadUp: (padIndex) => this.handleF1PadUp(padIndex),
      onMacroChange: (macroIndex, val) => this.handleF1MacroChange(macroIndex, val),
      onStopToggle: (colIndex, isActive) => this.handleF1StopToggle(colIndex, isActive),
      onFunctionButton: (btnName, isDown) => this.handleF1FunctionButton(btnName, isDown),
      onEncoderDelta: (delta, shiftHeld) => this.handleF1EncoderDelta(delta, shiftHeld),
      onSpaceBar: () => this.togglePlayPause()
    });

    const prCanvas = document.getElementById('playback-pianoroll-canvas');
    this.pianoRoll = new PianoRollTimelineUI(prCanvas, {
      onScrub: (timeSec) => this.scrubToTime(timeSec),
      onTakeModified: () => this._onPianoRollTakeEdited(),
      onPadAudition: (padIndex) => {
        this.handleF1PadDown(padIndex);
        setTimeout(() => this.handleF1PadUp(padIndex), 220);
      },
      onMacroLaneSelected: (macroIdx) => {
        const sel = document.getElementById('playback-macro-select');
        if (sel) sel.value = String(macroIdx);
      }
    });
  }

  getActiveTake() {
    const found = this.project.takes.find((t) => t.id === this.project.activeTakeId);
    return found || this.project.takes[0];
  }

  // =========================================================================
  // TRAKTOR KONTROL F1 HARDWARE EVENT HANDLERS across EDIT / PERFORM / PLAYBACK
  // =========================================================================
  handleF1PadDown(padIndex) {
    this.selectedPadIndex = padIndex;
    const pad = this.project.pads[padIndex];
    if (!pad) return;

    if (this.mode === 'edit') {
      // In Edit mode, pressing a pad selects it for editing AND previews it live
      if (pad.role === 'fx') {
        this.activeFxPads.add(padIndex);
      } else {
        this.activeClipPadIndex = padIndex;
        this.activeClipTriggeredAt = this.getLiveClockTime();
      }
      this._refreshEditPadInspector();
      this._updateActivePadIndicators();
      return;
    }

    if (this.mode === 'perform') {
      const now = this.getLiveClockTime();
      if (pad.role === 'fx') {
        if (pad.triggerMode === 'latch') {
          if (this.activeFxPads.has(padIndex)) this.activeFxPads.delete(padIndex);
          else this.activeFxPads.add(padIndex);
        } else {
          this.activeFxPads.add(padIndex);
        }
      } else {
        this.activeClipPadIndex = padIndex;
        this.activeClipTriggeredAt = now;
        this.stutterAnchorClipTime = pad.clipId ? 0 : 0;
      }

      if (this.isRecordingTake && this.activeRecorder) {
        this.activeRecorder.recordPadDown(padIndex, now, {
          quantize: this.liveQuantizeEnabled,
          reverse: this.liveReverseHeld
        });
      }
      this._updateActivePadIndicators();
      return;
    }

    if (this.mode === 'playback') {
      // If Overdub is active in Playback mode, punch new pad triggers directly into the active Take!
      if (this.isOverdubbing) {
        const take = this.getActiveTake();
        if (take) {
          const now = this.audio.getCurrentTime();
          const stepSec = gridDivisionToSeconds(this.project.audio.bpm, this.pianoRoll.gridDivision === 'off' ? '1/16' : this.pianoRoll.gridDivision);
          take.notes.push({
            id: `od-${Date.now()}-${padIndex}`,
            padIndex,
            startTime: Number(now.toFixed(4)),
            duration: Number(Math.max(0.15, stepSec).toFixed(4)),
            slipOffset: 0,
            reverse: this.liveReverseHeld
          });
          this.pianoRoll.render();
        }
      } else {
        // Audition pad in Playback mode
        if (pad.role === 'fx') {
          this.activeFxPads.add(padIndex);
        } else {
          this.activeClipPadIndex = padIndex;
        }
      }
    }
  }

  handleF1PadUp(padIndex) {
    const pad = this.project.pads[padIndex];
    if (!pad) return;

    if (pad.role === 'fx' && pad.triggerMode !== 'latch') {
      this.activeFxPads.delete(padIndex);
    }

    if (this.mode === 'perform' && this.isRecordingTake && this.activeRecorder) {
      this.activeRecorder.recordPadUp(padIndex, this.getLiveClockTime());
    }
    this._updateActivePadIndicators();
  }

  handleF1MacroChange(macroIndex, value) {
    this.project.macros[macroIndex].value = value;

    if (this.mode === 'perform' && this.isRecordingTake && this.activeRecorder) {
      this.activeRecorder.recordMacroChange(macroIndex, this.getLiveClockTime(), value);
    } else if (this.mode === 'playback') {
      // Select this macro lane in the Piano Roll automation editor
      this.pianoRoll.setActiveMacroIndex(macroIndex);
      const sel = document.getElementById('playback-macro-select');
      if (sel) sel.value = String(macroIndex);

      // Record live overdub automation points if Overdub is active (or update point at playhead)
      const take = this.getActiveTake();
      if (take) {
        const t = Number(this.audio.getCurrentTime().toFixed(4));
        const lane = take.automation[macroIndex];
        const existing = lane.find((p) => Math.abs(p.time - t) < 0.04);
        if (existing) {
          existing.value = value;
        } else {
          lane.push({ time: t, value });
          lane.sort((a, b) => a.time - b.time);
        }
        this.pianoRoll.render();
      }
    }
  }

  handleF1StopToggle(colIndex, isActive) {
    // Columns 1..4 Stop buttons act as instant Column Circuit-Bend Kill/Bypass
    this.bender.columnKill[colIndex] = isActive ? 1.0 : 0.0;
  }

  handleF1FunctionButton(btnName, isDown) {
    if (btnName === 'reverse') {
      this.liveReverseHeld = isDown;
      return;
    }
    if (!isDown) return;

    if (btnName === 'capture') {
      if (this.mode === 'edit') {
        this.snapshotLiveMacrosToSelectedPad();
      } else {
        this.toggleRecording();
      }
    } else if (btnName === 'quant') {
      if (this.mode === 'playback') {
        this.pianoRoll.quantizeSelectedOrAll();
      } else {
        this.liveQuantizeEnabled = !this.liveQuantizeEnabled;
        this.f1.setButtonLed('quant', this.liveQuantizeEnabled);
        const toggle = document.getElementById('perform-quantize-toggle');
        if (toggle) toggle.checked = this.liveQuantizeEnabled;
      }
    } else if (btnName === 'browse') {
      this.bender.clearFeedbackBuffers();
    } else if (btnName === 'type') {
      // Toggle current pad role between 'clip' and 'fx'
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.role = pad.role === 'clip' ? 'fx' : 'clip';
        pad.triggerMode = pad.role === 'fx' ? 'gate' : 'latch';
        this._refreshEditPadInspector();
        this._updateActivePadIndicators();
      }
    } else if (btnName === 'size') {
      // Cycle Stutter Roll division in Perform mode or Grid Snap in Playback mode
      const divs = ['off', '1/4', '1/8', '1/16', '1/32'];
      if (this.mode === 'playback') {
        const curIdx = divs.indexOf(this.pianoRoll.gridDivision);
        const nextDiv = divs[(curIdx + 1) % divs.length];
        this.pianoRoll.setGridDivision(nextDiv);
        const sel = document.getElementById('playback-grid-select');
        if (sel) sel.value = nextDiv;
      } else {
        const curIdx = divs.indexOf(this.liveStutterDivision);
        const nextDiv = divs[(curIdx + 1) % divs.length];
        this._setLiveStutterDivision(nextDiv);
      }
    } else if (btnName === 'sync') {
      this.audio.seek(0);
    } else if (btnName === 'encoderPress') {
      this.togglePlayPause();
    }
  }

  handleF1EncoderDelta(delta, shiftHeld) {
    if (this.mode === 'playback') {
      const beatSec = 60 / (this.project.audio.bpm || 128);
      const step = shiftHeld ? beatSec * 0.25 : beatSec;
      this.scrubToTime(this.audio.getCurrentTime() + delta * step);
    } else {
      // Nudge BPM in Perform / Edit mode
      const nextBpm = Math.max(40, Math.min(260, (this.project.audio.bpm || 128) + delta));
      this.setBpm(nextBpm);
    }
  }

  // =========================================================================
  // MODE SWITCHING (1. EDIT | 2. PERFORM | 3. PLAYBACK)
  // =========================================================================
  _initModeUI() {
    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const targetMode = tab.getAttribute('data-mode');
        this.setMode(targetMode);
      });
    });
  }

  setMode(newMode) {
    if (!['edit', 'perform', 'playback'].includes(newMode)) return;
    if (this.isRecordingTake && newMode !== 'perform') {
      this.stopRecordingTake();
    }
    this.mode = newMode;

    document.querySelectorAll('.mode-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-mode') === newMode);
    });
    document.getElementById('mode-panel-edit').classList.toggle('active', newMode === 'edit');
    document.getElementById('mode-panel-perform').classList.toggle('active', newMode === 'perform');
    document.getElementById('mode-panel-playback').classList.toggle('active', newMode === 'playback');

    // Update 7-Segment LED on Traktor Kontrol F1 to show mode code: ED / PF / PB
    const code = newMode === 'edit' ? 'ED' : newMode === 'perform' ? 'PF' : 'PB';
    this.f1.set7SegDisplay(code);

    if (newMode === 'playback') {
      this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
      setTimeout(() => this.pianoRoll.render(), 30);
    } else if (newMode === 'perform') {
      this._drawPerformWaveform();
    }
  }

  // =========================================================================
  // MODE 1: EDIT MODE CONTROLS
  // =========================================================================
  _initEditModeControls() {
    // Populate Canvas Presets
    const presetSel = document.getElementById('edit-canvas-preset');
    presetSel.innerHTML = CANVAS_PRESETS.map(
      (p) => `<option value="${p.id}">${p.label}</option>`
    ).join('');

    presetSel.addEventListener('change', (e) => {
      const preset = CANVAS_PRESETS.find((p) => p.id === e.target.value);
      if (preset) {
        this.project.canvas.presetId = preset.id;
        this.project.canvas.width = preset.width;
        this.project.canvas.height = preset.height;
        this.bender.setCanvasResolution(preset.width, preset.height);
        this._updateViewportHud();
      }
    });

    document.getElementById('edit-canvas-fps').addEventListener('change', (e) => {
      this.project.canvas.fps = Number(e.target.value) || 60;
      this._updateViewportHud();
    });

    document.getElementById('edit-canvas-fit').addEventListener('change', (e) => {
      this.project.canvas.aspectFit = e.target.value;
    });

    document.getElementById('edit-canvas-crt').addEventListener('change', (e) => {
      this.project.canvas.crtFrameEmulation = e.target.checked;
    });

    // Pad Assignment Inspector Controls
    document.getElementById('edit-pad-name').addEventListener('input', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.name = e.target.value;
        this._updateActivePadIndicators();
      }
    });

    document.getElementById('edit-pad-role').addEventListener('change', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.role = e.target.value;
        this._updateActivePadIndicators();
      }
    });

    document.getElementById('edit-pad-trigger').addEventListener('change', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.triggerMode = e.target.value;
        this._updateActivePadIndicators();
      }
    });

    document.getElementById('edit-pad-clip').addEventListener('change', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.clipId = e.target.value;
        this._refreshEditClipInspector();
      }
    });

    document.getElementById('edit-pad-color').addEventListener('input', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.color = e.target.value;
        this._updateActivePadIndicators();
      }
    });

    document.getElementById('edit-pad-reverse').addEventListener('change', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) pad.reverse = e.target.checked;
    });

    document.getElementById('edit-pad-quantize').addEventListener('change', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) pad.quantize = e.target.checked;
    });

    document.getElementById('edit-pad-speed').addEventListener('input', (e) => {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.speedMultiplier = Number(e.target.value);
        document.getElementById('edit-pad-speed-val').textContent = `${pad.speedMultiplier.toFixed(2)}×`;
      }
    });

    // Clip Trim & Geometry Controls
    document.getElementById('edit-clip-in').addEventListener('input', (e) => {
      const clip = this._getSelectedPadClip();
      if (!clip) return;
      clip.inPoint = Math.min(clip.outPoint - 0.1, Number(e.target.value));
      document.getElementById('edit-clip-in-val').textContent = `${clip.inPoint.toFixed(2)}s`;
    });

    document.getElementById('edit-clip-out').addEventListener('input', (e) => {
      const clip = this._getSelectedPadClip();
      if (!clip) return;
      clip.outPoint = Math.max(clip.inPoint + 0.1, Number(e.target.value));
      document.getElementById('edit-clip-out-val').textContent = `${clip.outPoint.toFixed(2)}s`;
    });

    document.getElementById('edit-clip-loop').addEventListener('change', (e) => {
      const clip = this._getSelectedPadClip();
      if (clip) clip.loopMode = e.target.value;
    });

    document.getElementById('edit-clip-speed').addEventListener('input', (e) => {
      const clip = this._getSelectedPadClip();
      if (clip) {
        clip.speed = Number(e.target.value);
        document.getElementById('edit-clip-speed-val').textContent = `${clip.speed.toFixed(2)}×`;
      }
    });

    document.getElementById('edit-clip-zoom').addEventListener('input', (e) => {
      const clip = this._getSelectedPadClip();
      if (clip) {
        clip.cropZoom = Number(e.target.value);
        document.getElementById('edit-clip-zoom-val').textContent = `${clip.cropZoom.toFixed(2)}×`;
      }
    });

    document.getElementById('edit-clip-fliph').addEventListener('change', (e) => {
      const clip = this._getSelectedPadClip();
      if (clip) clip.flipH = e.target.checked;
    });

    document.getElementById('edit-clip-flipv').addEventListener('change', (e) => {
      const clip = this._getSelectedPadClip();
      if (clip) clip.flipV = e.target.checked;
    });

    document.getElementById('btn-import-videos').addEventListener('click', () => this.importVideoFiles());
    document.getElementById('btn-import-video-quick').addEventListener('click', () => this.importVideoFiles());
    document.getElementById('btn-snapshot-f1-to-pad').addEventListener('click', () => this.snapshotLiveMacrosToSelectedPad());

    this._renderBendSignatureRows();
  }

  _renderBendSignatureRows() {
    const container = document.getElementById('edit-bend-signature-rows');
    container.innerHTML = GLOBAL_MACROS.map((m, idx) => {
      const prefix = idx < 4 ? `K${idx + 1}` : `F${idx - 3}`;
      return `
        <div class="bend-sig-row" style="--macro-color: ${m.color}" title="${m.description}">
          <span class="bend-sig-name">${prefix} ${m.shortName}</span>
          <input type="range" class="pad-bend-slider" data-macro="${idx}" min="0" max="1" step="0.01" value="0" />
          <span class="mono-val pad-bend-val" data-macro="${idx}">0%</span>
          <select class="macro-fft-select" data-macro="${idx}" title="Audio FFT Reactive Modulation Band">
            <option value="none">FFT: Off</option>
            <option value="sub">FFT: Sub</option>
            <option value="kick">FFT: Kick</option>
            <option value="mid">FFT: Mid</option>
            <option value="high">FFT: High</option>
          </select>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.pad-bend-slider').forEach((slider) => {
      slider.addEventListener('input', (e) => {
        const mIdx = Number(slider.getAttribute('data-macro'));
        const val = Number(e.target.value);
        const pad = this.project.pads[this.selectedPadIndex];
        if (pad) {
          pad.bendSignature[mIdx] = val;
          const valSpan = container.querySelector(`.pad-bend-val[data-macro="${mIdx}"]`);
          if (valSpan) valSpan.textContent = `${Math.round(val * 100)}%`;
        }
      });
    });

    container.querySelectorAll('.macro-fft-select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const mIdx = Number(sel.getAttribute('data-macro'));
        const band = e.target.value;
        this.project.macros[mIdx].fftBand = band;
        this.project.macros[mIdx].fftAmount = band === 'none' ? 0.0 : 0.35;
      });
    });
  }

  snapshotLiveMacrosToSelectedPad() {
    const pad = this.project.pads[this.selectedPadIndex];
    if (!pad) return;
    pad.bendSignature = this.project.macros.map((m) => Number(m.value.toFixed(3)));
    this._refreshEditPadInspector();
    this.f1.set7SegDisplay('SN');
  }

  _getSelectedPadClip() {
    const pad = this.project.pads[this.selectedPadIndex];
    if (!pad) return this.project.clips[0];
    return this.project.clips.find((c) => c.id === pad.clipId) || this.project.clips[0];
  }

  _refreshEditPadInspector() {
    const pad = this.project.pads[this.selectedPadIndex];
    if (!pad) return;

    document.getElementById('edit-selected-pad-badge').textContent = `PAD ${pad.index + 1} [Key ${pad.keyBinding}]`;
    document.getElementById('bend-lab-pad-title').textContent = `PAD ${pad.index + 1} (${pad.name})`;
    document.getElementById('edit-pad-name').value = pad.name;
    document.getElementById('edit-pad-role').value = pad.role;
    document.getElementById('edit-pad-trigger').value = pad.triggerMode;
    document.getElementById('edit-pad-color').value = pad.color;
    document.getElementById('edit-pad-reverse').checked = Boolean(pad.reverse);
    document.getElementById('edit-pad-quantize').checked = Boolean(pad.quantize);
    document.getElementById('edit-pad-speed').value = String(pad.speedMultiplier || 1.0);
    document.getElementById('edit-pad-speed-val').textContent = `${(pad.speedMultiplier || 1.0).toFixed(2)}×`;

    // Populate clip dropdown & clip pool list
    const clipSelect = document.getElementById('edit-pad-clip');
    clipSelect.innerHTML = this.project.clips
      .map((c) => `<option value="${c.id}">${c.sourceType === 'file' ? '🎬 ' : '⚡ '}${c.name}</option>`)
      .join('');
    clipSelect.value = pad.clipId;

    // Update Bend Signature sliders
    for (let m = 0; m < 8; m++) {
      const sigVal = pad.bendSignature[m] || 0;
      const slider = document.querySelector(`.pad-bend-slider[data-macro="${m}"]`);
      if (slider) slider.value = String(sigVal);
      const valSpan = document.querySelector(`.pad-bend-val[data-macro="${m}"]`);
      if (valSpan) valSpan.textContent = `${Math.round(sigVal * 100)}%`;
      const fftSel = document.querySelector(`.macro-fft-select[data-macro="${m}"]`);
      if (fftSel) fftSel.value = this.project.macros[m]?.fftBand || 'none';
    }

    this._refreshEditClipInspector();
  }

  _refreshEditClipInspector() {
    const clip = this._getSelectedPadClip();
    const listEl = document.getElementById('edit-clip-list');
    listEl.innerHTML = this.project.clips
      .map(
        (c) => `
      <div class="clip-item ${c.id === clip?.id ? 'active' : ''}" data-clip-id="${c.id}">
        <span class="clip-item-title">${c.sourceType === 'file' ? '🎬 ' : '⚡ '}${c.name}</span>
        <span class="clip-item-meta">${(c.duration || 16).toFixed(1)}s · ${c.loopMode}</span>
      </div>`
      )
      .join('');

    listEl.querySelectorAll('.clip-item').forEach((item) => {
      item.addEventListener('click', () => {
        const cid = item.getAttribute('data-clip-id');
        const pad = this.project.pads[this.selectedPadIndex];
        if (pad) {
          pad.clipId = cid;
          this._refreshEditPadInspector();
        }
      });
    });

    if (!clip) return;
    const dur = Math.max(0.5, Number(clip.duration) || 16);
    document.getElementById('edit-clip-duration-badge').textContent = `${dur.toFixed(2)}s`;

    const inSlider = document.getElementById('edit-clip-in');
    const outSlider = document.getElementById('edit-clip-out');
    inSlider.max = String(dur);
    outSlider.max = String(dur);
    inSlider.value = String(clip.inPoint || 0);
    outSlider.value = String(clip.outPoint || dur);

    document.getElementById('edit-clip-in-val').textContent = `${(clip.inPoint || 0).toFixed(2)}s`;
    document.getElementById('edit-clip-out-val').textContent = `${(clip.outPoint || dur).toFixed(2)}s`;
    document.getElementById('edit-clip-loop').value = clip.loopMode || 'loop';
    document.getElementById('edit-clip-speed').value = String(clip.speed || 1.0);
    document.getElementById('edit-clip-speed-val').textContent = `${(clip.speed || 1.0).toFixed(2)}×`;
    document.getElementById('edit-clip-zoom').value = String(clip.cropZoom || 1.0);
    document.getElementById('edit-clip-zoom-val').textContent = `${(clip.cropZoom || 1.0).toFixed(2)}×`;
    document.getElementById('edit-clip-fliph').checked = Boolean(clip.flipH);
    document.getElementById('edit-clip-flipv').checked = Boolean(clip.flipV);
  }

  // =========================================================================
  // MODE 2: PERFORM MODE CONTROLS & RECORDER
  // =========================================================================
  _initPerformModeControls() {
    document.getElementById('btn-perform-load-audio').addEventListener('click', () => this.loadExternalAudioFile());
    document.getElementById('btn-load-audio-quick').addEventListener('click', () => this.loadExternalAudioFile());

    document.getElementById('btn-perform-use-synth').addEventListener('click', async () => {
      await this.audio.loadBuiltInSynthTrack(this.project.audio.bpm || 128, 8);
      this.project.audio.sourceType = 'synth';
      this.project.audio.name = this.audio.trackName;
      this.project.audio.duration = this.audio.duration;
      this._syncAudioMetadataUI();
      this._drawPerformWaveform();
    });

    document.getElementById('perform-quantize-grid').addEventListener('change', (e) => {
      this.project.audio.quantizeGrid = e.target.value;
    });

    document.getElementById('perform-quantize-toggle').addEventListener('change', (e) => {
      this.liveQuantizeEnabled = e.target.checked;
      this.f1.setButtonLed('quant', this.liveQuantizeEnabled);
    });

    document.querySelectorAll('.stutter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const div = btn.getAttribute('data-stutter');
        this._setLiveStutterDivision(div);
      });
    });

    document.getElementById('btn-perform-big-rec').addEventListener('click', () => this.toggleRecording());

    // Click Perform waveform overview to seek
    const wfCanvas = document.getElementById('perform-waveform-canvas');
    wfCanvas.addEventListener('mousedown', (e) => {
      const rect = wfCanvas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      this.audio.seek(frac * this.audio.duration);
    });
  }

  _setLiveStutterDivision(div) {
    this.liveStutterDivision = div;
    this.stutterAnchorClipTime = this._currentLiveClipTime || 0;
    document.querySelectorAll('.stutter-btn').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-stutter') === div);
    });
    this.f1.setButtonLed('size', div !== 'off');
  }

  toggleRecording() {
    if (this.mode === 'playback') {
      // Toggle Live Overdub in Playback mode
      this.isOverdubbing = !this.isOverdubbing;
      this.f1.setButtonLed('capture', this.isOverdubbing);
      document.getElementById('btn-record-take').classList.toggle('is-recording', this.isOverdubbing);
      document.getElementById('badge-rec-state').classList.toggle('hidden', !this.isOverdubbing);
      document.getElementById('badge-rec-state').textContent = '● OVERDUB ACTIVE';
      if (this.isOverdubbing && !this.audio.isPlaying) {
        this.audio.play();
      }
      return;
    }

    // In Edit or Perform mode, start/stop a Performance Take recording
    if (this.mode === 'edit') {
      this.setMode('perform');
    }

    if (this.isRecordingTake) {
      this.stopRecordingTake();
    } else {
      this.startRecordingTake();
    }
  }

  async startRecordingTake() {
    this.activeRecorder = new PerformanceRecorder(this.project);
    // Log the currently latched clip pad at t=0.0 so the take starts with the active visual!
    this.activeRecorder.recordPadDown(this.activeClipPadIndex, 0.0);
    for (let m = 0; m < 8; m++) {
      this.activeRecorder.recordMacroChange(m, 0.0, this.project.macros[m].value);
    }

    this.isRecordingTake = true;
    this.f1.setButtonLed('capture', true);
    this.f1.set7SegDisplay('RE', true, true);
    document.getElementById('btn-record-take').classList.add('is-recording');
    document.getElementById('btn-perform-big-rec').classList.add('is-recording');
    document.getElementById('btn-perform-big-rec').textContent = '■ STOP RECORDING & OPEN IN PIANO ROLL';
    document.getElementById('perform-rec-status').textContent = '● RECORDING LIVE EVENTS';
    document.getElementById('badge-rec-state').classList.remove('hidden');
    document.getElementById('badge-rec-state').textContent = '● REC TAKE';

    this.audio.seek(0);
    await this.audio.play();
    this._updateTransportButtons();
  }

  stopRecordingTake() {
    if (!this.isRecordingTake || !this.activeRecorder) return;
    const endTime = Math.max(2.0, this.audio.getCurrentTime());
    const newTake = this.activeRecorder.finalize(endTime);
    this.project.takes.unshift(newTake);
    this.project.activeTakeId = newTake.id;

    this.isRecordingTake = false;
    this.activeRecorder = null;
    this.f1.setButtonLed('capture', false);
    document.getElementById('btn-record-take').classList.remove('is-recording');
    document.getElementById('btn-perform-big-rec').classList.remove('is-recording');
    document.getElementById('btn-perform-big-rec').textContent = '● START RECORDING TAKE (F1 CAPTURE)';
    document.getElementById('perform-rec-status').textContent = `SAVED ${newTake.notes.length} PAD EVENTS`;
    document.getElementById('badge-rec-state').classList.add('hidden');

    this._refreshTakesLists();
    this.setMode('playback');
  }

  _refreshTakesLists() {
    const perfList = document.getElementById('perform-takes-list');
    perfList.innerHTML = this.project.takes
      .map(
        (t) => `
      <div class="take-item ${t.id === this.project.activeTakeId ? 'active' : ''}" data-take-id="${t.id}">
        <div>
          <strong>${t.name}</strong>
          <div class="clip-item-meta">${t.notes.length} Pad Triggers · ${t.duration.toFixed(1)}s</div>
        </div>
        <button class="mini-action-btn accent">Edit in Piano Roll →</button>
      </div>`
      )
      .join('');

    perfList.querySelectorAll('.take-item').forEach((el) => {
      el.addEventListener('click', () => {
        this.project.activeTakeId = el.getAttribute('data-take-id');
        this._refreshTakesLists();
        this.setMode('playback');
      });
    });

    const pbSel = document.getElementById('playback-take-select');
    pbSel.innerHTML = this.project.takes
      .map((t) => `<option value="${t.id}">${t.name} (${t.notes.length} notes)</option>`)
      .join('');
    pbSel.value = this.project.activeTakeId;
  }

  _drawPerformWaveform() {
    const canvas = document.getElementById('perform-waveform-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#07090f';
    ctx.fillRect(0, 0, w, h);

    const dur = Math.max(0.1, this.audio.duration || 15);
    const bpm = this.project.audio.bpm || 128;
    const barSec = (60 / bpm) * 4;

    // Draw Bar grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    for (let t = 0; t <= dur; t += barSec) {
      const x = (t / dur) * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // Draw waveform peaks
    const peaks = this.audio.waveformPeaks;
    if (peaks && peaks.length > 0) {
      ctx.fillStyle = '#00f5d4';
      const midY = h * 0.5;
      const barW = Math.max(1, w / peaks.length);
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / peaks.length) * w;
        const amp = peaks[i] * (h * 0.44);
        ctx.fillRect(x, midY - amp, barW, amp * 2);
      }
    }

    // Draw Playhead
    const playX = (this.audio.getCurrentTime() / dur) * w;
    ctx.strokeStyle = '#ff2a6d';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(playX, 0);
    ctx.lineTo(playX, h);
    ctx.stroke();
  }

  // =========================================================================
  // MODE 3: PLAYBACK MODE CONTROLS (PIANO ROLL & 8-LANE MACRO AUTOMATION)
  // =========================================================================
  _initPlaybackModeControls() {
    document.getElementById('playback-take-select').addEventListener('change', (e) => {
      this.project.activeTakeId = e.target.value;
      this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
    });

    document.getElementById('btn-new-blank-take').addEventListener('click', () => {
      const rec = new PerformanceRecorder(
        this.project,
        `Blank Take ${this.project.takes.length + 1}`
      );
      rec.recordPadDown(0, 0.0);
      const take = rec.finalize(this.audio.duration || 15.0);
      this.project.takes.unshift(take);
      this.project.activeTakeId = take.id;
      this._refreshTakesLists();
      this.pianoRoll.setContext(this.project, take, this.audio.waveformPeaks);
    });

    // Piano Roll Tool Switcher
    document.querySelectorAll('.pr-tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tool = btn.getAttribute('data-tool');
        document.querySelectorAll('.pr-tool-btn').forEach((b) =>
          b.classList.toggle('active', b === btn)
        );
        this.pianoRoll.setTool(tool);
      });
    });

    document.getElementById('playback-grid-select').addEventListener('change', (e) => {
      this.pianoRoll.setGridDivision(e.target.value);
    });

    document.getElementById('btn-quantize-notes').addEventListener('click', () => {
      this.pianoRoll.quantizeSelectedOrAll();
    });

    document.getElementById('btn-delete-notes').addEventListener('click', () => {
      this.pianoRoll.deleteSelectedNotes();
    });

    // Populate 8 Macro Lane Selector
    const macroSel = document.getElementById('playback-macro-select');
    macroSel.innerHTML = GLOBAL_MACROS.map((m, i) => {
      const prefix = i < 4 ? `Knob ${i + 1}` : `Fader ${i - 3}`;
      return `<option value="${i}">${prefix}: ${m.shortName}</option>`;
    }).join('');

    macroSel.addEventListener('change', (e) => {
      this.pianoRoll.setActiveMacroIndex(Number(e.target.value));
    });

    document.getElementById('btn-smooth-macro').addEventListener('click', () => {
      this.pianoRoll.smoothActiveMacroLane();
    });

    document.getElementById('btn-lfo-sine').addEventListener('click', () => {
      this.pianoRoll.applyLfoToActiveMacro('sine');
    });

    document.getElementById('btn-lfo-saw').addEventListener('click', () => {
      this.pianoRoll.applyLfoToActiveMacro('saw');
    });

    document.getElementById('btn-clear-macro').addEventListener('click', () => {
      this.pianoRoll.clearActiveMacroLane();
    });
  }

  scrubToTime(timeSec) {
    const dur = this.audio.duration || this.getActiveTake()?.duration || 15.0;
    const clamped = Math.max(0, Math.min(dur, timeSec));
    this.isScrubbingTimeline = true;
    this.scrubTimestamp = clamped;
    this.audio.seek(clamped);
    this.pianoRoll.setPlayhead(clamped);
    clearTimeout(this._scrubTimeout);
    this._scrubTimeout = setTimeout(() => {
      this.isScrubbingTimeline = false;
    }, 120);
  }

  _onPianoRollTakeEdited() {
    this._refreshTakesLists();
  }

  // =========================================================================
  // MASTER TRANSPORT, MEDIA IMPORT & PROJECT PERSISTENCE
  // =========================================================================
  _initTransportAndProjectControls() {
    document.getElementById('btn-play-pause').addEventListener('click', () => this.togglePlayPause());
    document.getElementById('btn-stop').addEventListener('click', () => {
      if (this.isRecordingTake) this.stopRecordingTake();
      this.audio.stop();
      this._updateTransportButtons();
    });
    document.getElementById('btn-record-take').addEventListener('click', () => this.toggleRecording());

    document.getElementById('input-bpm').addEventListener('change', (e) => {
      this.setBpm(Number(e.target.value) || 128);
    });

    document.getElementById('btn-clear-feedback').addEventListener('click', () => {
      this.bender.clearFeedbackBuffers();
    });

    document.getElementById('btn-reset-macros').addEventListener('click', () => {
      GLOBAL_MACROS.forEach((m, idx) => {
        this.project.macros[idx].value = m.defaultValue;
        this.f1.setMacroValue(idx, m.defaultValue, false);
      });
    });

    document.getElementById('btn-save-project').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open-project').addEventListener('click', () => this.openProject());
  }

  async togglePlayPause() {
    if (this.audio.isPlaying) {
      this.audio.pause();
    } else {
      await this.audio.play();
    }
    this._updateTransportButtons();
  }

  _updateTransportButtons() {
    const playBtn = document.getElementById('btn-play-pause');
    playBtn.classList.toggle('is-playing', this.audio.isPlaying);
    playBtn.textContent = this.audio.isPlaying ? '❚❚ PAUSE' : '▶ PLAY';
  }

  setBpm(bpm) {
    const safe = Math.max(40, Math.min(260, Math.round(bpm)));
    this.project.audio.bpm = safe;
    this.audio.bpm = safe;
    document.getElementById('input-bpm').value = String(safe);
    if (this.project.audio.sourceType === 'synth') {
      this.audio.loadBuiltInSynthTrack(safe, 8).then(() => {
        this.project.audio.duration = this.audio.duration;
        this._drawPerformWaveform();
        this.pianoRoll.render();
      });
    } else {
      this.pianoRoll.render();
    }
  }

  async importVideoFiles() {
    if (!window.bentDesktop) return;
    const files = await window.bentDesktop.pickVideos();
    if (!files || !files.length) return;

    let firstClipId = null;
    for (const f of files) {
      const id = `clip-file-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      if (!firstClipId) firstClipId = id;
      const newClip = {
        id,
        name: f.name,
        sourceType: 'file',
        filePath: f.path,
        mediaUrl: f.mediaUrl,
        duration: 12.0,
        inPoint: 0.0,
        outPoint: 12.0,
        speed: 1.0,
        loopMode: 'loop',
        reverse: false,
        cropZoom: 1.0,
        flipH: false,
        flipV: false
      };
      this.project.clips.push(newClip);
      this.bender.ensureVideoElement(newClip);
    }

    // Assign the first newly imported video clip to the currently selected F1 pad
    if (firstClipId) {
      const pad = this.project.pads[this.selectedPadIndex];
      if (pad) {
        pad.clipId = firstClipId;
        pad.name = files[0].name.replace(/\.[^.]+$/, '').slice(0, 22);
      }
    }
    this._refreshEditPadInspector();
    this._updateActivePadIndicators();
  }

  async loadExternalAudioFile() {
    if (!window.bentDesktop) return;
    const picked = await window.bentDesktop.pickAudio();
    if (!picked || !picked.arrayBuffer) return;

    const info = await this.audio.loadAudioArrayBuffer(picked.arrayBuffer, picked.name);
    this.project.audio.sourceType = 'file';
    this.project.audio.filePath = picked.path;
    this.project.audio.name = info.name;
    this.project.audio.duration = info.duration;
    this.project.audio.bpm = info.bpm;
    this._syncAudioMetadataUI();
    this._drawPerformWaveform();
    this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
  }

  async saveProject() {
    if (!window.bentDesktop) return;
    const jsonString = JSON.stringify(this.project, null, 2);
    const res = await window.bentDesktop.saveProject({
      jsonString,
      currentPath: this.currentProjectPath
    });
    if (!res.canceled && res.filePath) {
      this.currentProjectPath = res.filePath;
    }
  }

  async openProject() {
    if (!window.bentDesktop) return;
    const res = await window.bentDesktop.openProject();
    if (res.canceled || !res.content) return;
    try {
      const parsed = JSON.parse(res.content);
      this.project = validateAndNormalizeProject(parsed);
      this.currentProjectPath = res.filePath;

      if (this.project.audio.sourceType === 'file' && this.project.audio.filePath) {
        const audioData = await window.bentDesktop.readAudioPath(this.project.audio.filePath);
        if (audioData && audioData.arrayBuffer) {
          await this.audio.loadAudioArrayBuffer(audioData.arrayBuffer, audioData.name);
        }
      } else {
        await this.audio.loadBuiltInSynthTrack(this.project.audio.bpm || 128, 8);
      }
      this.syncAllUIFromProject();
    } catch (err) {
      console.error('Failed to open .bent project:', err);
    }
  }

  syncAllUIFromProject() {
    this.bender.setCanvasResolution(this.project.canvas.width, this.project.canvas.height);
    document.getElementById('edit-canvas-preset').value = this.project.canvas.presetId || '1080p';
    document.getElementById('edit-canvas-fps').value = String(this.project.canvas.fps || 60);
    document.getElementById('edit-canvas-fit').value = this.project.canvas.aspectFit || 'cover';
    document.getElementById('edit-canvas-crt').checked = Boolean(this.project.canvas.crtFrameEmulation);

    this.f1.setAllMacros(this.project.macros.map((m) => m.value), false);
    this._syncAudioMetadataUI();
    this._refreshEditPadInspector();
    this._refreshTakesLists();
    this._updateActivePadIndicators();
    this._updateViewportHud();
    this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
  }

  _syncAudioMetadataUI() {
    document.getElementById('input-bpm').value = String(this.project.audio.bpm || 128);
    document.getElementById('perform-track-name').textContent = this.project.audio.name;
    document.getElementById('audio-track-pill').textContent = `${this.project.audio.bpm} BPM`;
  }

  _updateActivePadIndicators() {
    const flags = new Array(16).fill(false);
    flags[this.activeClipPadIndex] = true;
    for (const fxIdx of this.activeFxPads) {
      flags[fxIdx] = true;
    }
    this.f1.selectedPadIndex = this.selectedPadIndex;
    this.f1.updatePadsFromProject(this.project, flags);
  }

  _updateViewportHud(activeClipPad = null, activeFxList = []) {
    document.getElementById('badge-resolution').textContent =
      `${this.project.canvas.width}×${this.project.canvas.height} @ ${this.project.canvas.fps} FPS`;

    const pad = activeClipPad || this.project.pads[this.activeClipPadIndex] || this.project.pads[0];
    document.getElementById('badge-active-pad').textContent =
      `PAD ${pad.index + 1}: ${pad.name}`;

    const fxBadge = document.getElementById('badge-active-fx');
    if (activeFxList.length > 0) {
      fxBadge.classList.remove('hidden');
      const names = activeFxList.map((idx) => `P${idx + 1}`).join('+');
      fxBadge.textContent = `FX PUNCH: ${names}`;
    } else {
      fxBadge.classList.add('hidden');
    }
  }

  getLiveClockTime() {
    if (this.audio.isPlaying) {
      return this.audio.getCurrentTime();
    }
    return performance.now() * 0.001;
  }

  // =========================================================================
  // 60 FPS MASTER RENDER LOOP (EDIT / PERFORM / DETERMINISTIC PLAYBACK)
  // =========================================================================
  _startRenderLoop() {
    const tick = (nowMs) => {
      this._renderTick(nowMs * 0.001);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _renderTick(wallClockSec) {
    const fft = this.audio.getFFTData();
    this._updateFftMeters(fft);

    const audioTime = this.audio.getCurrentTime();
    this._updateTimecodeReadout(audioTime);

    if (this.mode === 'playback') {
      // --- DETERMINISTIC PLAYBACK MODE (Evaluated from Piano Roll + 8 Macro Lanes) ---
      const take = this.getActiveTake();
      const evalState = evaluateTimelineAt(take, this.project, audioTime);

      // Apply Audio FFT reactive boost on top of evaluated macro automation
      const finalMacros = evalState.macros.map((baseVal, mIdx) => {
        const band = this.project.macros[mIdx]?.fftBand;
        const amt = this.project.macros[mIdx]?.fftAmount || 0;
        const fftBoost = band && band !== 'none' ? (fft[band] || 0) * amt : 0;
        return Math.max(0, Math.min(1, baseVal + fftBoost));
      });

      this.bender.renderFrame({
        clip: evalState.clip,
        clipTime: evalState.clipTime,
        globalTime: audioTime,
        macros: finalMacros,
        fft,
        aspectFit: this.project.canvas.aspectFit,
        crtEmulation: this.project.canvas.crtFrameEmulation,
        isScrubbing: this.isScrubbingTimeline || !this.audio.isPlaying
      });

      // Keep Virtual & Physical F1 pads and 8 Macro indicators synchronized with Playback timeline!
      this.f1.updatePadsFromProject(this.project, evalState.activePadFlags);
      if (!this.isOverdubbing) {
        this.f1.setAllMacros(evalState.rawAutomationMacros, false);
      }
      this.pianoRoll.setPlayhead(audioTime);
      this._updateViewportHud(
        this.project.pads[evalState.activeClipPadIndex],
        evalState.activeFxPadIndices
      );
      return;
    }

    // --- LIVE EDIT & PERFORM MODE ---
    const clockTime = this.audio.isPlaying ? audioTime : wallClockSec;
    const activePad = this.project.pads[this.activeClipPadIndex] || this.project.pads[0];
    const clip = this.project.clips.find((c) => c.id === activePad.clipId) || this.project.clips[0];

    let clipTime = computeDeterministicClipTime(
      clip,
      activePad,
      {
        startTime: this.activeClipTriggeredAt,
        slipOffset: 0,
        reverse: this.liveReverseHeld
      },
      clockTime
    );

    // Apply live Stutter Roll division if active in Perform Mode
    if (this.liveStutterDivision !== 'off') {
      const stutterStep = gridDivisionToSeconds(this.project.audio.bpm || 128, this.liveStutterDivision);
      if (stutterStep > 0.02) {
        clipTime = this.stutterAnchorClipTime + (clockTime % stutterStep);
      }
    }
    this._currentLiveClipTime = clipTime;

    // Combine 8 live F1 Macros + active Clip pad baseline signature + active FX Punch pads + Audio FFT
    const liveMacros = new Array(8).fill(0);
    for (let m = 0; m < 8; m++) {
      const f1Val = this.project.macros[m]?.value || 0;
      const clipSig = (activePad?.bendSignature?.[m] || 0) * 0.45;
      let fxSum = 0;
      for (const fxIdx of this.activeFxPads) {
        const fxPad = this.project.pads[fxIdx];
        if (fxPad?.bendSignature) {
          fxSum += (fxPad.bendSignature[m] || 0) * 0.85;
        }
      }
      const band = this.project.macros[m]?.fftBand;
      const amt = this.project.macros[m]?.fftAmount || 0;
      const fftBoost = band && band !== 'none' ? (fft[band] || 0) * amt : 0;

      liveMacros[m] = Math.max(0, Math.min(1, f1Val + clipSig + fxSum + fftBoost));
    }

    this.bender.renderFrame({
      clip,
      clipTime,
      globalTime: clockTime,
      macros: liveMacros,
      fft,
      aspectFit: this.project.canvas.aspectFit,
      crtEmulation: this.project.canvas.crtFrameEmulation,
      isScrubbing: false
    });

    if (this.mode === 'perform') {
      this._drawPerformWaveform();
    }
    this._updateViewportHud(activePad, Array.from(this.activeFxPads));
  }

  _updateFftMeters(fft) {
    document.getElementById('fft-fill-sub').style.height = `${Math.max(6, Math.round((fft.sub || 0) * 100))}%`;
    document.getElementById('fft-fill-kick').style.height = `${Math.max(6, Math.round((fft.kick || 0) * 100))}%`;
    document.getElementById('fft-fill-mid').style.height = `${Math.max(6, Math.round((fft.mid || 0) * 100))}%`;
    document.getElementById('fft-fill-high').style.height = `${Math.max(6, Math.round((fft.high || 0) * 100))}%`;
  }

  _updateTimecodeReadout(timeSec) {
    document.getElementById('timecode-display').textContent = `${timeSec.toFixed(2)}s`;
    const bpm = this.project.audio.bpm || 128;
    const beatSec = 60 / bpm;
    const totalBeats = Math.floor(timeSec / beatSec);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = (totalBeats % 4) + 1;
    document.getElementById('bar-beat-display').textContent = `BAR ${bar}.${beat}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.bentApp = new BentWorkstationApp();
});
