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
  mergeAutomationOverdub,
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

    // Scrubbing & audition state for Playback mode
    this.isScrubbingTimeline = false;
    this.scrubTimestamp = 0;
    this.playbackAuditionClipPad = null;

    // Performance & debounce state
    this._bpmSynthTimer = null;
    this._bpmSynthSeq = 0;
    this._toastTimer = null;
    this._lastFrameMs = 0;
    this._lastHudState = {};
    this._lastPerformWfTime = -1;
    this._dom = this._cacheHotDomRefs();

    this._initEngines();
    this._initModeUI();
    this._initEditModeControls();
    this._initPerformModeControls();
    this._initPlaybackModeControls();
    this._initTransportAndProjectControls();

    this.syncAllUIFromProject();
    this._startRenderLoop();
  }

  _cacheHotDomRefs() {
    return {
      fftSub: document.getElementById('fft-fill-sub'),
      fftKick: document.getElementById('fft-fill-kick'),
      fftMid: document.getElementById('fft-fill-mid'),
      fftHigh: document.getElementById('fft-fill-high'),
      timecode: document.getElementById('timecode-display'),
      barBeat: document.getElementById('bar-beat-display'),
      badgeRes: document.getElementById('badge-resolution'),
      badgePad: document.getElementById('badge-active-pad'),
      badgeFx: document.getElementById('badge-active-fx'),
      badgeRec: document.getElementById('badge-rec-state'),
      badgeToast: document.getElementById('badge-toast'),
      btnRecord: document.getElementById('btn-record-take')
    };
  }

  _showToast(message, isError = false, durationMs = 3600) {
    const el = this._dom.badgeToast;
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    el.classList.toggle('error', Boolean(isError));
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, durationMs);
  }

  _initEngines() {
    const glCanvas = document.getElementById('bent-webgl-canvas');
    this.bender = new WebGLVideoBender(glCanvas, {
      onClipMetadataLoaded: (loadedClip) => {
        if (this._getSelectedPadClip()?.id === loadedClip.id) {
          this._refreshEditClipInspector();
        }
      }
    });

    this.audio = new AudioDeckEngine();
    this.audio.onTrackEnded = () => {
      if (this.isRecordingTake) {
        this.stopRecordingTake({ overrideEndTime: this.audio.duration });
        this._showToast('Take auto-saved at end of music track');
      }
      this._updateTransportButtons();
    };

    // Pre-generate the built-in 128 BPM 8-bar synth breakbeat track asynchronously
    this.audio.loadBuiltInSynthTrack(this.project.audio.bpm, 8).then(() => {
      this._drawPerformWaveform(true);
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
      onSpaceBar: () => this.togglePlayPause(),
      onDeleteKey: () => {
        if (this.mode === 'playback') {
          this.pianoRoll.deleteSelectedNotes();
        }
      },
      onSaveShortcut: () => this.saveProject(),
      onUndoShortcut: () => {
        if (this.mode === 'playback' && this.pianoRoll.undo()) {
          this._showToast('Undo');
        }
      },
      onRedoShortcut: () => {
        if (this.mode === 'playback' && this.pianoRoll.redo()) {
          this._showToast('Redo');
        }
      },
      onMidiMapChanged: (midiMap) => {
        this.project.midiMap = midiMap;
      }
    });

    const prCanvas = document.getElementById('playback-pianoroll-canvas');
    this.pianoRoll = new PianoRollTimelineUI(prCanvas, {
      onScrub: (timeSec) => this.scrubToTime(timeSec),
      onTakeModified: () => this._onPianoRollTakeEdited(),
      onPadAudition: (padIndex) => {
        this.handleF1PadDown(padIndex);
        clearTimeout(this._auditionTimeout);
        this._auditionTimeout = setTimeout(() => this.handleF1PadUp(padIndex), 320);
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
        const clip = this.project.clips.find((c) => c.id === pad.clipId);
        this.stutterAnchorClipTime = Number(clip?.inPoint) || 0;
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
          this.pianoRoll._pushUndoSnapshot();
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
          this._refreshTakesLists();
          this.pianoRoll.render();
        }
      } else {
        // Live pad audition preview in Playback mode
        if (pad.role === 'fx') {
          this.activeFxPads.add(padIndex);
        } else {
          this.playbackAuditionClipPad = padIndex;
          this.activeClipTriggeredAt = this.getLiveClockTime();
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
    if (this.mode === 'playback' && this.playbackAuditionClipPad === padIndex) {
      this.playbackAuditionClipPad = null;
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

      // ONLY mutate recorded automation when Overdub is actively armed
      if (this.isOverdubbing) {
        const take = this.getActiveTake();
        if (take) {
          const t = Number(this.audio.getCurrentTime().toFixed(4));
          const lane = Array.isArray(take.automation[macroIndex]) ? take.automation[macroIndex] : [];
          take.automation[macroIndex] = mergeAutomationOverdub(
            lane,
            [{ time: t, value }],
            Math.max(0, t - 0.04),
            t + 0.04
          );
          this.pianoRoll.render();
        }
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
      this.stopRecordingTake({ switchToPlayback: false });
    }
    if (this.isOverdubbing && newMode !== 'playback') {
      this._setOverdubState(false);
    }
    this.playbackAuditionClipPad = null;
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
      this._drawPerformWaveform(true);
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
      const clamped = Math.max(0, Math.min(clip.outPoint - 0.1, Number(e.target.value)));
      clip.inPoint = clamped;
      e.target.value = String(clamped);
      document.getElementById('edit-clip-in-val').textContent = `${clip.inPoint.toFixed(2)}s`;
    });

    document.getElementById('edit-clip-out').addEventListener('input', (e) => {
      const clip = this._getSelectedPadClip();
      if (!clip) return;
      const clamped = Math.min(clip.duration || 16, Math.max(clip.inPoint + 0.1, Number(e.target.value)));
      clip.outPoint = clamped;
      e.target.value = String(clamped);
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

    // Populate clip dropdown safely using DOM APIs (prevents XSS from filenames/project names)
    const clipSelect = document.getElementById('edit-pad-clip');
    clipSelect.replaceChildren();
    for (const c of this.project.clips) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.sourceType === 'file' ? '[FILE] ' : '[SYNTH] '}${c.name}`;
      clipSelect.appendChild(opt);
    }
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
    listEl.replaceChildren();
    for (const c of this.project.clips) {
      const item = document.createElement('div');
      item.className = `clip-item${c.id === clip?.id ? ' active' : ''}`;
      item.dataset.clipId = c.id;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'clip-item-title';
      titleSpan.textContent = `${c.sourceType === 'file' ? '[FILE] ' : '[SYNTH] '}${c.name}`;

      const metaSpan = document.createElement('span');
      metaSpan.className = 'clip-item-meta';
      metaSpan.textContent = `${(c.duration || 16).toFixed(1)}s · ${c.loopMode}`;

      item.appendChild(titleSpan);
      item.appendChild(metaSpan);
      item.addEventListener('click', () => {
        const pad = this.project.pads[this.selectedPadIndex];
        if (pad) {
          pad.clipId = c.id;
          this._refreshEditPadInspector();
        }
      });
      listEl.appendChild(item);
    }

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
      this.project.audio.filePath = null;
      this.project.audio.name = this.audio.trackName;
      this.project.audio.duration = this.audio.duration;
      this._syncAudioMetadataUI();
      this._drawPerformWaveform(true);
      this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
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

  _setOverdubState(enabled) {
    this.isOverdubbing = Boolean(enabled);
    this.f1.setButtonLed('capture', this.isOverdubbing);
    this._dom.btnRecord?.classList.toggle('is-recording', this.isOverdubbing);
    if (this._dom.badgeRec) {
      this._dom.badgeRec.classList.toggle('hidden', !this.isOverdubbing);
      this._dom.badgeRec.textContent = '● OVERDUB ACTIVE';
    }
  }

  toggleRecording() {
    if (this.mode === 'playback') {
      // Toggle Live Overdub in Playback mode
      this._setOverdubState(!this.isOverdubbing);
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

    // Disable audio looping while recording so timestamps stay strictly monotonic in [0, duration]
    this.audio.setLoop(false);
    this.audio.seek(0);

    this.isRecordingTake = true;
    this.f1.setButtonLed('capture', true);
    this.f1.set7SegDisplay('RE', true, true);
    this._dom.btnRecord?.classList.add('is-recording');
    document.getElementById('btn-perform-big-rec').classList.add('is-recording');
    document.getElementById('btn-perform-big-rec').textContent = '■ STOP RECORDING & OPEN IN PIANO ROLL';
    document.getElementById('perform-rec-status').textContent = '● RECORDING LIVE EVENTS';
    if (this._dom.badgeRec) {
      this._dom.badgeRec.classList.remove('hidden');
      this._dom.badgeRec.textContent = '● REC TAKE';
    }

    await this.audio.play();
    this._updateTransportButtons();
  }

  stopRecordingTake({ switchToPlayback = true, overrideEndTime = null } = {}) {
    if (!this.isRecordingTake || !this.activeRecorder) return;
    const rawEnd = overrideEndTime !== null ? overrideEndTime : this.audio.getCurrentTime();
    const endTime = Math.max(2.0, rawEnd);
    const newTake = this.activeRecorder.finalize(endTime);
    this.project.takes.unshift(newTake);
    this.project.activeTakeId = newTake.id;

    this.isRecordingTake = false;
    this.activeRecorder = null;
    this.audio.setLoop(true);
    this.f1.setButtonLed('capture', false);
    this._dom.btnRecord?.classList.remove('is-recording');
    document.getElementById('btn-perform-big-rec').classList.remove('is-recording');
    document.getElementById('btn-perform-big-rec').textContent = '● START RECORDING TAKE (F1 CAPTURE)';
    document.getElementById('perform-rec-status').textContent = `SAVED ${newTake.notes.length} PAD EVENTS`;
    this._dom.badgeRec?.classList.add('hidden');

    this._refreshTakesLists();
    if (switchToPlayback) {
      this.setMode('playback');
    }
  }

  _refreshTakesLists() {
    const perfList = document.getElementById('perform-takes-list');
    perfList.replaceChildren();
    for (const t of this.project.takes) {
      const item = document.createElement('div');
      item.className = `take-item${t.id === this.project.activeTakeId ? ' active' : ''}`;
      item.dataset.takeId = t.id;

      const infoDiv = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = t.name;
      const meta = document.createElement('div');
      meta.className = 'clip-item-meta';
      meta.textContent = `${t.notes.length} Pad Triggers · ${t.duration.toFixed(1)}s`;
      infoDiv.appendChild(strong);
      infoDiv.appendChild(meta);

      const editBtn = document.createElement('button');
      editBtn.className = 'mini-action-btn accent';
      editBtn.textContent = 'Edit in Piano Roll →';

      item.appendChild(infoDiv);
      item.appendChild(editBtn);
      item.addEventListener('click', () => {
        this.project.activeTakeId = t.id;
        this._refreshTakesLists();
        this.setMode('playback');
      });
      perfList.appendChild(item);
    }

    const pbSel = document.getElementById('playback-take-select');
    pbSel.replaceChildren();
    for (const t of this.project.takes) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.notes.length} notes)`;
      pbSel.appendChild(opt);
    }
    pbSel.value = this.project.activeTakeId;
  }

  _drawPerformWaveform(force = false) {
    const curTime = this.audio.getCurrentTime();
    if (!force && Math.abs(curTime - this._lastPerformWfTime) < 1e-3) {
      return;
    }
    this._lastPerformWfTime = curTime;
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
    const playX = (curTime / dur) * w;
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
      if (this.isOverdubbing) this._setOverdubState(false);
      this.audio.stop();
      this._drawPerformWaveform(true);
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
    document.getElementById('audio-track-pill').textContent = `${safe} BPM`;
    if (this.project.audio.sourceType === 'synth') {
      // Debounce synchronous audio buffer synthesis when spinning the F1 encoder
      clearTimeout(this._bpmSynthTimer);
      const seq = ++this._bpmSynthSeq;
      this._bpmSynthTimer = setTimeout(() => {
        this.audio.loadBuiltInSynthTrack(safe, 8).then(() => {
          if (seq !== this._bpmSynthSeq) return;
          this.project.audio.duration = this.audio.duration;
          this.project.audio.name = this.audio.trackName;
          this._syncAudioMetadataUI();
          this._drawPerformWaveform(true);
          this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
        });
      }, 180);
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

  async _fetchAudioArrayBuffer(mediaUrl, filePath) {
    if (mediaUrl) {
      const resp = await fetch(mediaUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} loading audio`);
      }
      return await resp.arrayBuffer();
    }
    if (window.bentDesktop && filePath) {
      const audioData = await window.bentDesktop.readAudioPath(filePath);
      if (audioData?.error) throw new Error(audioData.error);
      if (audioData?.arrayBuffer) return audioData.arrayBuffer;
    }
    throw new Error('Unable to read audio file');
  }

  async loadExternalAudioFile() {
    if (!window.bentDesktop) return;
    const picked = await window.bentDesktop.pickAudio();
    if (!picked) return;
    if (picked.error) {
      this._showToast(`Audio load failed: ${picked.error}`, true);
      return;
    }

    try {
      const arrayBuffer = picked.arrayBuffer || (await this._fetchAudioArrayBuffer(picked.mediaUrl, picked.path));
      const info = await this.audio.loadAudioArrayBuffer(arrayBuffer, picked.name);
      this.project.audio.sourceType = 'file';
      this.project.audio.filePath = picked.path;
      this.project.audio.name = info.name;
      this.project.audio.duration = info.duration;
      this.project.audio.bpm = info.bpm;
      this._syncAudioMetadataUI();
      this._drawPerformWaveform(true);
      this.pianoRoll.setContext(this.project, this.getActiveTake(), this.audio.waveformPeaks);
      this._showToast(`Loaded ${info.name} (${info.bpm} BPM)`);
    } catch (err) {
      console.error('Failed to decode audio file:', err);
      this._showToast(`Audio decode error: ${err.message}`, true);
    }
  }

  async saveProject() {
    if (!window.bentDesktop) return;
    this.project.midiMap = this.f1.getMidiMap();
    const jsonString = JSON.stringify(this.project, null, 2);
    const res = await window.bentDesktop.saveProject({
      jsonString,
      currentPath: this.currentProjectPath
    });
    if (res?.error) {
      this._showToast(`Save failed: ${res.error}`, true);
      return;
    }
    if (!res.canceled && res.filePath) {
      this.currentProjectPath = res.filePath;
      this._showToast('Project saved');
    }
  }

  async openProject() {
    if (!window.bentDesktop) return;
    const res = await window.bentDesktop.openProject();
    if (res?.error) {
      this._showToast(`Open failed: ${res.error}`, true);
      return;
    }
    if (res.canceled || !res.content) return;
    try {
      const parsed = JSON.parse(res.content);
      this.audio.stop();
      this.bender.disposeVideoElements();
      this.project = validateAndNormalizeProject(parsed);
      this.currentProjectPath = res.filePath;

      if (this.project.midiMap) {
        this.f1.setMidiMap(this.project.midiMap);
      }

      if (this.project.audio.sourceType === 'file' && this.project.audio.filePath) {
        try {
          const mediaUrl = window.bentDesktop.toMediaUrl(this.project.audio.filePath);
          const arrayBuffer = await this._fetchAudioArrayBuffer(mediaUrl, this.project.audio.filePath);
          const info = await this.audio.loadAudioArrayBuffer(arrayBuffer, this.project.audio.name);
          this.project.audio.duration = info.duration;
        } catch (audioErr) {
          console.error('Project audio file missing or unreadable:', audioErr);
          this._showToast('Audio file missing — using built-in synth fallback', true, 5000);
          await this.audio.loadBuiltInSynthTrack(this.project.audio.bpm || 128, 8);
        }
      } else {
        await this.audio.loadBuiltInSynthTrack(this.project.audio.bpm || 128, 8);
      }
      this.syncAllUIFromProject();
      this._drawPerformWaveform(true);
      this._updateTransportButtons();
      this._showToast(`Opened ${this.project.name}`);
    } catch (err) {
      console.error('Failed to open .bent project:', err);
      this._showToast(`Invalid project file: ${err.message}`, true, 5000);
    }
  }

  syncAllUIFromProject() {
    this.bender.setCanvasResolution(this.project.canvas.width, this.project.canvas.height);
    document.getElementById('edit-canvas-preset').value = this.project.canvas.presetId || '1080p';
    document.getElementById('edit-canvas-fps').value = String(this.project.canvas.fps || 60);
    document.getElementById('edit-canvas-fit').value = this.project.canvas.aspectFit || 'cover';
    document.getElementById('edit-canvas-crt').checked = Boolean(this.project.canvas.crtFrameEmulation);
    document.getElementById('perform-quantize-grid').value = this.project.audio.quantizeGrid || '1/16';

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
    const resText = `${this.project.canvas.width}×${this.project.canvas.height} @ ${this.project.canvas.fps} FPS`;
    if (this._lastHudState.res !== resText) {
      this._lastHudState.res = resText;
      if (this._dom.badgeRes) this._dom.badgeRes.textContent = resText;
    }

    const pad = activeClipPad || this.project.pads[this.activeClipPadIndex] || this.project.pads[0];
    const padText = `PAD ${pad.index + 1}: ${pad.name}`;
    if (this._lastHudState.pad !== padText) {
      this._lastHudState.pad = padText;
      if (this._dom.badgePad) this._dom.badgePad.textContent = padText;
    }

    const fxText = activeFxList.length > 0 ? `FX PUNCH: ${activeFxList.map((idx) => `P${idx + 1}`).join('+')}` : '';
    if (this._lastHudState.fx !== fxText) {
      this._lastHudState.fx = fxText;
      if (this._dom.badgeFx) {
        if (fxText) {
          this._dom.badgeFx.classList.remove('hidden');
          this._dom.badgeFx.textContent = fxText;
        } else {
          this._dom.badgeFx.classList.add('hidden');
        }
      }
    }
  }

  getLiveClockTime() {
    if (this.audio.isPlaying) {
      return this.audio.getCurrentTime();
    }
    return performance.now() * 0.001;
  }

  // =========================================================================
  // MASTER RENDER LOOP (Respects project.canvas.fps & passes frame dt)
  // =========================================================================
  _startRenderLoop() {
    const tick = (nowMs) => {
      const targetFps = Math.max(15, Number(this.project.canvas.fps) || 60);
      const minIntervalMs = targetFps >= 60 ? 0 : 1000 / targetFps - 1.5;
      const elapsedMs = this._lastFrameMs ? nowMs - this._lastFrameMs : 1000 / 60;
      if (elapsedMs >= minIntervalMs) {
        const dt = Math.min(0.1, Math.max(0.004, elapsedMs * 0.001));
        this._lastFrameMs = nowMs;
        this._renderTick(nowMs * 0.001, dt);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _renderTick(wallClockSec, dt = 1 / 60) {
    const fft = this.audio.getFFTData();
    this._updateFftMeters(fft);

    const audioTime = this.audio.getCurrentTime();
    this._updateTimecodeReadout(audioTime);

    if (this.mode === 'playback') {
      // --- DETERMINISTIC PLAYBACK MODE (Evaluated from Piano Roll + 8 Macro Lanes) ---
      const take = this.getActiveTake();
      const evalState = evaluateTimelineAt(take, this.project, audioTime);

      // Allow live pad audition preview in Playback mode when holding a pad (outside Overdub)
      let activeClipPad = this.project.pads[evalState.activeClipPadIndex] || this.project.pads[0];
      let clip = evalState.clip;
      let clipTime = evalState.clipTime;
      let activeFxIndices = [...evalState.activeFxPadIndices];
      let activePadFlags = [...evalState.activePadFlags];
      let isReversed = Boolean(clip?.reverse) !== Boolean(activeClipPad?.reverse) !== Boolean(evalState.activeClipNote?.reverse);

      if (!this.isOverdubbing && this.playbackAuditionClipPad !== null) {
        const audPad = this.project.pads[this.playbackAuditionClipPad];
        if (audPad) {
          activeClipPad = audPad;
          clip = this.project.clips.find((c) => c.id === audPad.clipId) || this.project.clips[0];
          const clockT = this.audio.isPlaying ? audioTime : wallClockSec;
          clipTime = computeDeterministicClipTime(
            clip,
            audPad,
            { startTime: this.activeClipTriggeredAt, slipOffset: 0, reverse: this.liveReverseHeld },
            clockT
          );
          isReversed = Boolean(clip?.reverse) !== Boolean(audPad.reverse) !== Boolean(this.liveReverseHeld);
          activePadFlags[this.playbackAuditionClipPad] = true;
        }
      }

      if (!this.isOverdubbing && this.activeFxPads.size > 0) {
        for (const fxIdx of this.activeFxPads) {
          if (!activeFxIndices.includes(fxIdx)) activeFxIndices.push(fxIdx);
          activePadFlags[fxIdx] = true;
        }
      }

      // Apply Audio FFT reactive boost (+ any auditioned FX pads) on top of evaluated macro automation
      const finalMacros = evalState.macros.map((baseVal, mIdx) => {
        let extraFx = 0;
        if (!this.isOverdubbing && this.activeFxPads.size > 0) {
          for (const fxIdx of this.activeFxPads) {
            if (!evalState.activeFxPadIndices.includes(fxIdx)) {
              extraFx += (this.project.pads[fxIdx]?.bendSignature?.[mIdx] || 0) * 0.85;
            }
          }
        }
        const band = this.project.macros[mIdx]?.fftBand;
        const amt = this.project.macros[mIdx]?.fftAmount || 0;
        const fftBoost = band && band !== 'none' ? (fft[band] || 0) * amt : 0;
        return Math.max(0, Math.min(1, baseVal + extraFx + fftBoost));
      });

      const playbackSpeed = (Number(clip?.speed) || 1.0) * (Number(activeClipPad?.speedMultiplier) || 1.0);

      this.bender.renderFrame({
        clip,
        clipTime,
        globalTime: audioTime,
        dt,
        macros: finalMacros,
        fft,
        aspectFit: this.project.canvas.aspectFit,
        crtEmulation: this.project.canvas.crtFrameEmulation,
        isScrubbing: this.isScrubbingTimeline || (!this.audio.isPlaying && this.playbackAuditionClipPad === null),
        playbackSpeed,
        isReversed
      });

      // Keep Virtual & Physical F1 pads and 8 Macro indicators synchronized with Playback timeline!
      this.f1.updatePadsFromProject(this.project, activePadFlags);
      if (!this.isOverdubbing) {
        this.f1.setAllMacros(evalState.rawAutomationMacros, false);
      }
      this.pianoRoll.setPlayhead(audioTime);
      this._updateViewportHud(activeClipPad, activeFxIndices);
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

    // Apply live Stutter Roll division if active in Perform Mode (clamped/wrapped inside [inPoint, outPoint])
    if (this.liveStutterDivision !== 'off') {
      const stutterStep = gridDivisionToSeconds(this.project.audio.bpm || 128, this.liveStutterDivision);
      if (stutterStep > 0.02) {
        const inPt = Math.max(0, Number(clip?.inPoint) || 0);
        const fullDur = Math.max(0.1, Number(clip?.duration) || 10);
        const outPt = Math.max(inPt + 0.05, Math.min(fullDur, Number(clip?.outPoint) || fullDur));
        const span = outPt - inPt;
        const rel = (this.stutterAnchorClipTime - inPt) + (clockTime % stutterStep);
        clipTime = inPt + (((rel % span) + span) % span);
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

    const playbackSpeed = (Number(clip?.speed) || 1.0) * (Number(activePad?.speedMultiplier) || 1.0);
    const isReversed = Boolean(clip?.reverse) !== Boolean(activePad?.reverse) !== Boolean(this.liveReverseHeld);

    this.bender.renderFrame({
      clip,
      clipTime,
      globalTime: clockTime,
      dt,
      macros: liveMacros,
      fft,
      aspectFit: this.project.canvas.aspectFit,
      crtEmulation: this.project.canvas.crtFrameEmulation,
      isScrubbing: this.liveStutterDivision !== 'off',
      playbackSpeed,
      isReversed
    });

    if (this.mode === 'perform') {
      this._drawPerformWaveform(false);
    }
    this._updateViewportHud(activePad, Array.from(this.activeFxPads));
  }

  _updateFftMeters(fft) {
    if (this._dom.fftSub) this._dom.fftSub.style.height = `${Math.max(6, Math.round((fft.sub || 0) * 100))}%`;
    if (this._dom.fftKick) this._dom.fftKick.style.height = `${Math.max(6, Math.round((fft.kick || 0) * 100))}%`;
    if (this._dom.fftMid) this._dom.fftMid.style.height = `${Math.max(6, Math.round((fft.mid || 0) * 100))}%`;
    if (this._dom.fftHigh) this._dom.fftHigh.style.height = `${Math.max(6, Math.round((fft.high || 0) * 100))}%`;
  }

  _updateTimecodeReadout(timeSec) {
    const tcText = `${timeSec.toFixed(2)}s`;
    if (this._lastHudState.tc !== tcText) {
      this._lastHudState.tc = tcText;
      if (this._dom.timecode) this._dom.timecode.textContent = tcText;
    }
    const bpm = this.project.audio.bpm || 128;
    const beatSec = 60 / bpm;
    const totalBeats = Math.floor(timeSec / beatSec);
    const bar = Math.floor(totalBeats / 4) + 1;
    const beat = (totalBeats % 4) + 1;
    const bbText = `BAR ${bar}.${beat}`;
    if (this._lastHudState.bb !== bbText) {
      this._lastHudState.bb = bbText;
      if (this._dom.barBeat) this._dom.barBeat.textContent = bbText;
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.bentApp = new BentWorkstationApp();
});
