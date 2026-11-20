// Dual WebHID (0x17CC:0x1120) + WebMIDI Service & Interactive On-Screen
// Native Instruments Traktor Kontrol F1 Control Surface Component.

import {
  NI_VENDOR_ID,
  F1_PRODUCT_ID,
  F1_OUTPUT_REPORT_ID,
  parseF1HidInputReport,
  buildF1HidOutputPayload,
  createDefaultF1MidiMap,
  parseF1MidiMessage
} from '../shared/f1-hid-protocol.js';
import { GLOBAL_MACROS, PAD_KEY_BINDINGS } from '../shared/project-schema.js';

export class F1HardwareController {
  constructor(containerEl, callbacks = {}) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    this.hidDevice = null;
    this.previousHidState = null;
    this._lastHidPayload = null;
    this._hidSendInFlight = false;
    this._hidDirty = false;
    this.midiAccess = null;
    this.midiMap = this._loadSavedMidiMap();
    this.midiLearnActive = false;
    this.midiLearnTarget = null; // { kind: 'pad'|'macro'|'stop'|'button', indexOrName }

    this.connectionStatus = 'Virtual F1 + Keyboard Ready';
    this.displayText = '01';
    this.leftDot = false;
    this.rightDot = false;

    this.padPressed = new Array(16).fill(false);
    this.activePads = new Array(16).fill(false);
    this.padColors = new Array(16).fill('#00f5d4');
    this.macroValues = GLOBAL_MACROS.map((m) => m.defaultValue);
    this.stopStates = [false, false, false, false];
    this.buttonStates = {
      shift: false,
      reverse: false,
      type: false,
      size: false,
      browse: false,
      capture: false,
      quant: false,
      sync: false
    };

    this.selectedPadIndex = 0;
    this._dom = {};
    this._lastPadRenderState = null;
    this._renderDOM();
    this._bindKeyboardShortcuts();
    this.initHardwareAutoConnect();
  }

  _loadSavedMidiMap() {
    const def = createDefaultF1MidiMap();
    try {
      const raw = window.localStorage?.getItem('bent.f1MidiMap.v1');
      if (!raw) return def;
      const parsed = JSON.parse(raw);
      return {
        padNotes: Array.isArray(parsed.padNotes) && parsed.padNotes.length === 16 ? parsed.padNotes : def.padNotes,
        macroCCs: Array.isArray(parsed.macroCCs) && parsed.macroCCs.length === 8 ? parsed.macroCCs : def.macroCCs,
        stopCCs: Array.isArray(parsed.stopCCs) && parsed.stopCCs.length === 4 ? parsed.stopCCs : def.stopCCs,
        buttonCCs: { ...def.buttonCCs, ...(parsed.buttonCCs || {}) }
      };
    } catch (_e) {
      return def;
    }
  }

  _saveMidiMap() {
    try {
      window.localStorage?.setItem('bent.f1MidiMap.v1', JSON.stringify(this.midiMap));
    } catch (_e) {
      // Ignore storage errors
    }
    this.callbacks.onMidiMapChanged?.(this.getMidiMap());
  }

  getMidiMap() {
    return structuredClone(this.midiMap);
  }

  setMidiMap(map) {
    if (!map || typeof map !== 'object') return;
    const def = createDefaultF1MidiMap();
    this.midiMap = {
      padNotes: Array.isArray(map.padNotes) && map.padNotes.length === 16 ? [...map.padNotes] : def.padNotes,
      macroCCs: Array.isArray(map.macroCCs) && map.macroCCs.length === 8 ? [...map.macroCCs] : def.macroCCs,
      stopCCs: Array.isArray(map.stopCCs) && map.stopCCs.length === 4 ? [...map.stopCCs] : def.stopCCs,
      buttonCCs: { ...def.buttonCCs, ...(map.buttonCCs || {}) }
    };
    try {
      window.localStorage?.setItem('bent.f1MidiMap.v1', JSON.stringify(this.midiMap));
    } catch (_e) {
      // Ignore
    }
  }

  async initHardwareAutoConnect() {
    // 1. Try WebMIDI
    if (navigator.requestMIDIAccess) {
      try {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        this._attachMidiInputs();
        this.midiAccess.onstatechange = () => this._attachMidiInputs();
      } catch (_err) {
        // WebMIDI unavailable
      }
    }

    // 2. Check already-granted WebHID devices for Traktor Kontrol F1
    if (navigator.hid) {
      try {
        const devices = await navigator.hid.getDevices();
        const f1 = devices.find(
          (d) => d.vendorId === NI_VENDOR_ID && d.productId === F1_PRODUCT_ID
        ) || devices.find((d) => d.vendorId === NI_VENDOR_ID);
        if (f1) {
          await this._openHidDevice(f1);
        }
        navigator.hid.addEventListener('connect', async (e) => {
          if (e.device.vendorId === NI_VENDOR_ID) {
            await this._openHidDevice(e.device);
          }
        });
        navigator.hid.addEventListener('disconnect', (e) => {
          if (this.hidDevice === e.device) {
            this.hidDevice = null;
            this._updateStatusBadge('F1 USB Disconnected (Virtual Ready)');
          }
        });
      } catch (_err) {
        // WebHID error
      }
    }
  }

  async requestHidConnection() {
    if (!navigator.hid) {
      this._updateStatusBadge('WebHID not supported');
      return;
    }
    try {
      const devices = await navigator.hid.requestDevice({
        filters: [
          { vendorId: NI_VENDOR_ID, productId: F1_PRODUCT_ID },
          { vendorId: NI_VENDOR_ID }
        ]
      });
      if (devices && devices.length > 0) {
        await this._openHidDevice(devices[0]);
      } else {
        this._updateStatusBadge('No Traktor F1 found on USB');
      }
    } catch (err) {
      this._updateStatusBadge(`HID Error: ${err.message}`);
    }
  }

  async _openHidDevice(device) {
    try {
      if (!device.opened) {
        await device.open();
      }
      this.hidDevice = device;
      this.previousHidState = null;
      this._lastHidPayload = null;
      device.oninputreport = (event) => this._handleHidInputReport(event);
      this._updateStatusBadge(`F1 Connected (USB HID: ${device.productName || 'Traktor Kontrol F1'})`);
      await this.syncHardwareLeds(true);
    } catch (err) {
      this._updateStatusBadge(`F1 HID Open Failed: ${err.message}`);
    }
  }

  _handleHidInputReport(event) {
    const prevEnc = this.previousHidState ? this.previousHidState.encoderByte : null;
    const parsed = parseF1HidInputReport(event.data, prevEnc);
    if (!parsed) return;

    const prev = this.previousHidState;
    this.previousHidState = parsed;

    // 1. Check 16 Pads
    for (let i = 0; i < 16; i++) {
      const wasDown = prev ? prev.pads[i] : false;
      const isDown = parsed.pads[i];
      if (isDown !== wasDown) {
        this._triggerPadFromHardware(i, isDown);
      }
    }

    // 2. Check 8 Global Macros (Knobs 1-4 & Faders 1-4)
    // Skip emitting on the very first HID snapshot (!prev) so connecting the F1
    // does not overwrite active Playback automation or project defaults.
    if (prev) {
      for (let m = 0; m < 8; m++) {
        const oldVal = prev.macros[m];
        const newVal = parsed.macros[m];
        if (Math.abs(newVal - oldVal) >= 0.0025) {
          this.setMacroValue(m, newVal, true);
        }
      }
    }

    // 3. Check 4 Bottom Stop Buttons
    for (let s = 0; s < 4; s++) {
      const wasDown = prev ? prev.stops[s] : false;
      const isDown = parsed.stops[s];
      if (isDown && !wasDown) {
        this._toggleStopButton(s, true);
      }
    }

    // 4. Check Function Buttons
    for (const [btnName, isDown] of Object.entries(parsed.buttons)) {
      if (btnName.startsWith('stop')) continue;
      const wasDown = prev ? prev.buttons[btnName] : false;
      if (isDown !== wasDown) {
        this._handleFunctionButton(btnName, isDown);
      }
    }

    // 5. Check Rotary Encoder Delta
    if (parsed.encoderDelta !== 0) {
      this.callbacks.onEncoderDelta?.(parsed.encoderDelta, this.buttonStates.shift);
    }
  }

  _attachMidiInputs() {
    if (!this.midiAccess) return;
    let connectedNames = [];
    for (const input of this.midiAccess.inputs.values()) {
      connectedNames.push(input.name);
      input.onmidimessage = (msg) => this._handleMidiMessage(msg.data);
    }
    if (!this.hidDevice && connectedNames.length > 0) {
      this._updateStatusBadge(`MIDI Active: ${connectedNames[0]}`);
    }
  }

  _handleMidiMessage(data) {
    if (!data || data.length < 3) return;
    const status = data[0] & 0xf0;
    const d1 = data[1];
    const d2 = data[2];

    // Handle 1-Click MIDI Learn binding
    if (this.midiLearnActive && this.midiLearnTarget) {
      if (status === 0x90 && d2 > 0 && this.midiLearnTarget.kind === 'pad') {
        this.midiMap.padNotes[this.midiLearnTarget.index] = d1;
        this._saveMidiMap();
        this._finishMidiLearn(`Mapped Pad ${this.midiLearnTarget.index + 1} to Note ${d1}`);
        return;
      }
      if (status === 0xb0) {
        if (this.midiLearnTarget.kind === 'macro') {
          this.midiMap.macroCCs[this.midiLearnTarget.index] = d1;
          this._saveMidiMap();
          this._finishMidiLearn(`Mapped Macro ${this.midiLearnTarget.index + 1} to CC ${d1}`);
          return;
        }
        if (this.midiLearnTarget.kind === 'pad' && d2 > 0) {
          // Clear any conflicting macro CC so the pad binding is not shadowed
          for (let i = 0; i < this.midiMap.macroCCs.length; i++) {
            if (this.midiMap.macroCCs[i] === d1) this.midiMap.macroCCs[i] = -1;
          }
          this.midiMap.padNotes[this.midiLearnTarget.index] = d1;
          this._saveMidiMap();
          this._finishMidiLearn(`Mapped Pad ${this.midiLearnTarget.index + 1} to CC ${d1}`);
          return;
        }
        if (this.midiLearnTarget.kind === 'stop' && d2 > 0) {
          this.midiMap.stopCCs[this.midiLearnTarget.index] = d1;
          this._saveMidiMap();
          this._finishMidiLearn(`Mapped Stop ${this.midiLearnTarget.index + 1} to CC ${d1}`);
          return;
        }
        if (this.midiLearnTarget.kind === 'button' && d2 > 0) {
          this.midiMap.buttonCCs[this.midiLearnTarget.name] = d1;
          this._saveMidiMap();
          this._finishMidiLearn(`Mapped ${this.midiLearnTarget.name.toUpperCase()} to CC ${d1}`);
          return;
        }
      }
    }

    const parsed = parseF1MidiMessage(data, this.midiMap);
    if (!parsed) return;

    if (parsed.type === 'pad-down') {
      this._triggerPadFromHardware(parsed.padIndex, true);
    } else if (parsed.type === 'pad-up') {
      this._triggerPadFromHardware(parsed.padIndex, false);
    } else if (parsed.type === 'macro-change') {
      this.setMacroValue(parsed.macroIndex, parsed.value, true);
    } else if (parsed.type === 'stop-button' && parsed.pressed) {
      this._toggleStopButton(parsed.stopIndex, true);
    } else if (parsed.type === 'function-button') {
      this._handleFunctionButton(parsed.button, parsed.pressed);
    } else if (parsed.type === 'encoder-step') {
      this.callbacks.onEncoderDelta?.(parsed.delta, this.buttonStates.shift);
    }
  }

  toggleMidiLearn() {
    this.midiLearnActive = !this.midiLearnActive;
    this.midiLearnTarget = null;
    const btn = this.containerEl.querySelector('#f1-midi-learn-btn');
    if (btn) {
      btn.classList.toggle('active', this.midiLearnActive);
      btn.textContent = this.midiLearnActive ? 'Click Any Control...' : 'MIDI Learn';
    }
  }

  _finishMidiLearn(msg) {
    this.midiLearnActive = false;
    this.midiLearnTarget = null;
    const btn = this.containerEl.querySelector('#f1-midi-learn-btn');
    if (btn) {
      btn.classList.remove('active');
      btn.textContent = 'MIDI Learn';
    }
    this._updateStatusBadge(msg);
  }

  async syncHardwareLeds(force = false) {
    if (!this.hidDevice || !this.hidDevice.opened) return;

    const payload = buildF1HidOutputPayload({
      displayText: this.displayText,
      leftDot: this.leftDot,
      rightDot: this.rightDot,
      buttons: this.buttonStates,
      padColors: this.padColors,
      activePads: this.activePads.map((a, i) => a || this.padPressed[i]),
      stops: this.stopStates
    });

    // Skip redundant USB HID writes when LED state has not changed
    if (!force && this._lastHidPayload && this._lastHidPayload.length === payload.length) {
      let identical = true;
      for (let i = 0; i < payload.length; i++) {
        if (this._lastHidPayload[i] !== payload[i]) {
          identical = false;
          break;
        }
      }
      if (identical) return;
    }

    if (this._hidSendInFlight) {
      this._hidDirty = true;
      return;
    }

    this._hidSendInFlight = true;
    this._hidDirty = false;
    try {
      await this.hidDevice.sendReport(F1_OUTPUT_REPORT_ID, payload);
      this._lastHidPayload = payload;
    } catch (_err) {
      // Ignore transient USB write errors
    } finally {
      this._hidSendInFlight = false;
      if (this._hidDirty) {
        this._hidDirty = false;
        this.syncHardwareLeds(false);
      }
    }
  }

  set7SegDisplay(text, leftDot = false, rightDot = false) {
    const nextText = String(text ?? '01').toUpperCase().padStart(2, '0').slice(-2);
    const nextLeft = Boolean(leftDot);
    const nextRight = Boolean(rightDot);
    if (
      this.displayText === nextText &&
      this.leftDot === nextLeft &&
      this.rightDot === nextRight
    ) {
      return;
    }
    this.displayText = nextText;
    this.leftDot = nextLeft;
    this.rightDot = nextRight;
    const el = this._dom.sevenSeg;
    if (el) {
      el.textContent = this.displayText;
      el.classList.toggle('dot-left', this.leftDot);
      el.classList.toggle('dot-right', this.rightDot);
    }
    this.syncHardwareLeds();
  }

  updatePadsFromProject(project, activePadFlags = null) {
    if (!project || !Array.isArray(project.pads)) return;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      const pad = project.pads[i];
      const nextColor = pad.color || '#00f5d4';
      const nextActive = activePadFlags ? Boolean(activePadFlags[i]) : this.activePads[i];
      const nextSelected = i === this.selectedPadIndex;
      const nextRole = pad.role === 'fx' ? 'FX PUNCH' : pad.triggerMode.toUpperCase();

      const prev = this._lastPadRenderState?.[i];
      if (
        prev &&
        prev.color === nextColor &&
        prev.active === nextActive &&
        prev.selected === nextSelected &&
        prev.isFx === (pad.role === 'fx') &&
        prev.name === pad.name &&
        prev.roleText === nextRole
      ) {
        continue;
      }

      changed = true;
      this.padColors[i] = nextColor;
      this.activePads[i] = nextActive;

      const refs = this._dom.pads?.[i];
      if (refs) {
        refs.el.style.setProperty('--pad-color', nextColor);
        refs.el.classList.toggle('is-active', nextActive);
        refs.el.classList.toggle('is-selected', nextSelected);
        refs.el.classList.toggle('is-fx', pad.role === 'fx');
        if (refs.nameEl) refs.nameEl.textContent = pad.name;
        if (refs.roleEl) refs.roleEl.textContent = nextRole;
      }

      if (!this._lastPadRenderState) {
        this._lastPadRenderState = new Array(16);
      }
      this._lastPadRenderState[i] = {
        color: nextColor,
        active: nextActive,
        selected: nextSelected,
        isFx: pad.role === 'fx',
        name: pad.name,
        roleText: nextRole
      };
    }
    if (changed) {
      this.syncHardwareLeds();
    }
  }

  setMacroValue(macroIndex, value, emitCallback = false) {
    if (macroIndex < 0 || macroIndex >= 8) return;
    const clamped = Math.max(0, Math.min(1, Number(value) || 0));
    const unchanged = Math.abs(this.macroValues[macroIndex] - clamped) < 1e-4;
    this.macroValues[macroIndex] = clamped;

    if (!unchanged || !this._dom.macrosInitialized) {
      if (macroIndex < 4) {
        const refs = this._dom.knobs?.[macroIndex];
        if (refs) {
          const angle = -135 + clamped * 270;
          if (refs.dial) refs.dial.style.transform = `rotate(${angle}deg)`;
          if (refs.valEl) refs.valEl.textContent = `${Math.round(clamped * 100)}%`;
        }
      } else {
        const refs = this._dom.faders?.[macroIndex - 4];
        if (refs) {
          if (refs.input && document.activeElement !== refs.input) {
            refs.input.value = String(clamped);
          }
          if (refs.fill) refs.fill.style.height = `${clamped * 100}%`;
          if (refs.valEl) refs.valEl.textContent = `${Math.round(clamped * 100)}%`;
        }
      }
    }

    if (emitCallback) {
      this.callbacks.onMacroChange?.(macroIndex, clamped);
    }
  }

  setAllMacros(valuesArray, emitCallback = false) {
    for (let m = 0; m < 8; m++) {
      if (typeof valuesArray[m] === 'number') {
        this.setMacroValue(m, valuesArray[m], emitCallback);
      }
    }
    this._dom.macrosInitialized = true;
  }

  setButtonLed(buttonName, isActive) {
    if (!(buttonName in this.buttonStates)) return;
    const next = Boolean(isActive);
    if (this.buttonStates[buttonName] === next) return;
    this.buttonStates[buttonName] = next;
    const btnEl = this._dom.fnBtns?.[buttonName];
    if (btnEl) {
      btnEl.classList.toggle('is-lit', next);
    }
    this.syncHardwareLeds();
  }

  _triggerPadFromHardware(padIndex, isDown) {
    this.padPressed[padIndex] = isDown;
    const refs = this._dom.pads?.[padIndex];
    if (refs) {
      refs.el.classList.toggle('is-pressed', isDown);
    }
    if (isDown) {
      this.selectedPadIndex = padIndex;
      this.set7SegDisplay(String(padIndex + 1).padStart(2, '0'));
      this.callbacks.onPadDown?.(padIndex);
    } else {
      this.callbacks.onPadUp?.(padIndex);
    }
    this.syncHardwareLeds();
  }

  _toggleStopButton(colIndex, emit = true) {
    this.stopStates[colIndex] = !this.stopStates[colIndex];
    const btn = this._dom.stops?.[colIndex];
    if (btn) {
      btn.classList.toggle('is-active', this.stopStates[colIndex]);
    }
    this.syncHardwareLeds();
    if (emit) {
      this.callbacks.onStopToggle?.(colIndex, this.stopStates[colIndex]);
    }
  }

  _handleFunctionButton(btnName, isDown) {
    if (btnName === 'reverse' || btnName === 'shift') {
      // Momentary modifier buttons
      this.setButtonLed(btnName, isDown);
      this.callbacks.onFunctionButton?.(btnName, isDown);
      return;
    }
    if (isDown) {
      this.callbacks.onFunctionButton?.(btnName, true);
    }
  }

  _updateStatusBadge(text) {
    this.connectionStatus = text;
    const badge = this._dom.statusBadge;
    if (badge) {
      badge.textContent = text;
      badge.classList.toggle('connected', Boolean(this.hidDevice));
    }
  }

  _bindKeyboardShortcuts() {
    const keyToPad = new Map();
    PAD_KEY_BINDINGS.forEach((k, idx) => keyToPad.set(k.toUpperCase(), idx));

    window.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
        return;
      }

      // Standard modifier shortcuts (do not let them trigger pad keys)
      if (e.ctrlKey || e.metaKey || e.altKey) {
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const lower = e.key.toLowerCase();
          if (lower === 's') {
            e.preventDefault();
            this.callbacks.onSaveShortcut?.();
          } else if (lower === 'z' && !e.shiftKey) {
            e.preventDefault();
            this.callbacks.onUndoShortcut?.();
          } else if ((lower === 'z' && e.shiftKey) || lower === 'y') {
            e.preventDefault();
            this.callbacks.onRedoShortcut?.();
          }
        }
        return;
      }

      if (e.repeat) return;
      const key = e.key.toUpperCase();
      if (keyToPad.has(key)) {
        e.preventDefault();
        this._triggerPadFromHardware(keyToPad.get(key), true);
      } else if (e.code === 'Space') {
        e.preventDefault();
        this.callbacks.onSpaceBar?.();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.callbacks.onDeleteKey?.();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toUpperCase();
      if (keyToPad.has(key)) {
        e.preventDefault();
        this._triggerPadFromHardware(keyToPad.get(key), false);
      }
    });
  }

  _renderDOM() {
    const knobsHtml = GLOBAL_MACROS.slice(0, 4)
      .map(
        (m, i) => `
      <div class="f1-knob-control" data-macro="${i}" title="${m.name}">
        <div class="f1-col-header">C${i + 1}</div>
        <div class="f1-knob-outer" style="--macro-color: ${m.color}">
          <div class="f1-knob-dial" style="transform: rotate(${-135 + m.defaultValue * 270}deg)">
            <div class="f1-knob-marker"></div>
          </div>
        </div>
        <div class="f1-macro-label">${m.shortName}</div>
        <div class="f1-macro-val">${Math.round(m.defaultValue * 100)}%</div>
      </div>`
      )
      .join('');

    const fadersHtml = GLOBAL_MACROS.slice(4, 8)
      .map(
        (m, i) => `
      <div class="f1-fader-control" data-macro="${i + 4}" title="${m.name}">
        <div class="f1-fader-track" style="--macro-color: ${m.color}">
          <div class="f1-fader-fill" style="height: ${m.defaultValue * 100}%"></div>
          <input type="range" min="0" max="1" step="0.005" value="${m.defaultValue}" aria-label="${m.name}" />
        </div>
        <div class="f1-macro-label">${m.shortName}</div>
        <div class="f1-macro-val">${Math.round(m.defaultValue * 100)}%</div>
      </div>`
      )
      .join('');

    const padsHtml = Array.from({ length: 16 }, (_, i) => `
      <button class="f1-pad ${i === 0 ? 'is-selected is-active' : ''}" data-pad="${i}" style="--pad-color: #00f5d4">
        <div class="f1-pad-top">
          <span class="f1-pad-num">${i + 1}</span>
          <span class="f1-pad-key">[${PAD_KEY_BINDINGS[i]}]</span>
        </div>
        <div class="f1-pad-name">Pad ${i + 1}</div>
        <div class="f1-pad-role">LATCH</div>
      </button>`
    ).join('');

    const stopsHtml = Array.from({ length: 4 }, (_, i) => `
      <button class="f1-stop-btn" data-stop="${i}" title="Column ${i + 1} Kill / Overdub Arm">
        <span>MUTE / ARM ${i + 1}</span>
      </button>`
    ).join('');

    this.containerEl.innerHTML = `
      <div class="f1-chassis">
        <div class="f1-brand-bar">
          <div class="f1-brand-title">TRAKTOR <strong>KONTROL F1</strong></div>
          <div class="f1-hw-actions">
            <button id="f1-connect-hid-btn" class="f1-mini-btn" title="Connect Physical F1 via USB WebHID (No NI Drivers Needed)">USB HID</button>
            <button id="f1-midi-learn-btn" class="f1-mini-btn" title="Bind Custom MIDI Notes/CCs">MIDI Learn</button>
          </div>
        </div>
        <div id="f1-connection-badge" class="f1-status-line">${this.connectionStatus}</div>

        <!-- 4 Rotary Filter Knobs (Macros 1-4) -->
        <div class="f1-knobs-row">${knobsHtml}</div>

        <!-- 4 Vertical Faders (Macros 5-8) -->
        <div class="f1-faders-row">${fadersHtml}</div>

        <!-- Middle Utility Section: 7-Seg Display, Push Encoder & Function Buttons -->
        <div class="f1-utility-deck">
          <div class="f1-display-col">
            <div class="f1-7seg-box">
              <span id="f1-7seg-text">01</span>
            </div>
            <div class="f1-encoder-wrap" id="f1-encoder" title="Scroll or Drag to Scrub / Nudge; Click to Play/Pause">
              <div class="f1-encoder-cap">PUSH</div>
            </div>
          </div>
          <div class="f1-fn-grid">
            <button class="f1-fn-btn" data-btn="shift" title="Hold for Fine Adjust">SHIFT</button>
            <button class="f1-fn-btn" data-btn="reverse" title="Hold to Reverse Video Playback">REVERSE</button>
            <button class="f1-fn-btn" data-btn="type" title="Cycle Pad Role (Clip vs FX Punch)">TYPE</button>
            <button class="f1-fn-btn" data-btn="size" title="Cycle Stutter / Grid Division">SIZE</button>
            <button class="f1-fn-btn" data-btn="browse" title="Reset Feedback Buffers">CLEAR FB</button>
            <button class="f1-fn-btn f1-btn-capture" data-btn="capture" title="Arm / Start Performance Recording or Overdub">CAPTURE</button>
            <button class="f1-fn-btn" data-btn="quant" title="Quantize Live Pad Triggers or Selected Piano Roll Notes">QUANT</button>
            <button class="f1-fn-btn" data-btn="sync" title="Sync Tempo / Reset Beat Phase">SYNC</button>
          </div>
        </div>

        <!-- 4x4 RGB Backlit Velocity Pad Matrix -->
        <div class="f1-pads-grid">${padsHtml}</div>

        <!-- 4 Bottom Stop / Kill / Overdub Arm Buttons -->
        <div class="f1-stops-row">${stopsHtml}</div>
      </div>
    `;

    this._cacheDomRefs();
    this._bindUIDomEvents();
  }

  _cacheDomRefs() {
    this._dom = {
      sevenSeg: this.containerEl.querySelector('#f1-7seg-text'),
      statusBadge: this.containerEl.querySelector('#f1-connection-badge'),
      pads: Array.from({ length: 16 }, (_, i) => {
        const el = this.containerEl.querySelector(`.f1-pad[data-pad="${i}"]`);
        return el
          ? { el, nameEl: el.querySelector('.f1-pad-name'), roleEl: el.querySelector('.f1-pad-role') }
          : null;
      }),
      knobs: Array.from({ length: 4 }, (_, i) => {
        const el = this.containerEl.querySelector(`.f1-knob-control[data-macro="${i}"]`);
        return el
          ? { el, dial: el.querySelector('.f1-knob-dial'), valEl: el.querySelector('.f1-macro-val') }
          : null;
      }),
      faders: Array.from({ length: 4 }, (_, i) => {
        const el = this.containerEl.querySelector(`.f1-fader-control[data-macro="${i + 4}"]`);
        return el
          ? {
              el,
              input: el.querySelector('input[type="range"]'),
              fill: el.querySelector('.f1-fader-fill'),
              valEl: el.querySelector('.f1-macro-val')
            }
          : null;
      }),
      fnBtns: Object.fromEntries(
        Array.from(this.containerEl.querySelectorAll('.f1-fn-btn')).map((el) => [
          el.getAttribute('data-btn'),
          el
        ])
      ),
      stops: Array.from({ length: 4 }, (_, i) =>
        this.containerEl.querySelector(`.f1-stop-btn[data-stop="${i}"]`)
      ),
      macrosInitialized: false
    };
  }

  _bindUIDomEvents() {
    const connectBtn = this.containerEl.querySelector('#f1-connect-hid-btn');
    connectBtn?.addEventListener('click', () => this.requestHidConnection());

    const learnBtn = this.containerEl.querySelector('#f1-midi-learn-btn');
    learnBtn?.addEventListener('click', () => this.toggleMidiLearn());

    // Rotary Knobs drag interaction
    this.containerEl.querySelectorAll('.f1-knob-control').forEach((knobEl) => {
      const macroIndex = Number(knobEl.getAttribute('data-macro'));
      let startY = 0;
      let startVal = 0;

      knobEl.addEventListener('mousedown', (e) => {
        if (this.midiLearnActive) {
          this.midiLearnTarget = { kind: 'macro', index: macroIndex };
          this._updateStatusBadge(`Move Knob ${macroIndex + 1} on F1...`);
          return;
        }
        e.preventDefault();
        startY = e.clientY;
        startVal = this.macroValues[macroIndex];

        const onMove = (me) => {
          const dy = startY - me.clientY;
          const step = this.buttonStates.shift ? 0.0015 : 0.0055;
          this.setMacroValue(macroIndex, startVal + dy * step, true);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      });

      knobEl.addEventListener('dblclick', () => {
        this.setMacroValue(macroIndex, GLOBAL_MACROS[macroIndex].defaultValue, true);
      });
    });

    // Vertical Faders interaction
    this.containerEl.querySelectorAll('.f1-fader-control').forEach((faderEl) => {
      const macroIndex = Number(faderEl.getAttribute('data-macro'));
      const input = faderEl.querySelector('input[type="range"]');
      input?.addEventListener('mousedown', () => {
        if (this.midiLearnActive) {
          this.midiLearnTarget = { kind: 'macro', index: macroIndex };
          this._updateStatusBadge(`Move Fader ${macroIndex - 3} on F1...`);
        }
      });
      input?.addEventListener('input', (e) => {
        this.setMacroValue(macroIndex, Number(e.target.value), true);
      });
      faderEl.addEventListener('dblclick', () => {
        this.setMacroValue(macroIndex, GLOBAL_MACROS[macroIndex].defaultValue, true);
      });
    });

    // 16 Pads mouse down/up (supports both Gate hold and Latch switch)
    this.containerEl.querySelectorAll('.f1-pad').forEach((padEl) => {
      const padIndex = Number(padEl.getAttribute('data-pad'));
      padEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.midiLearnActive) {
          this.midiLearnTarget = { kind: 'pad', index: padIndex };
          this._updateStatusBadge(`Press Pad ${padIndex + 1} on F1...`);
          return;
        }
        this._triggerPadFromHardware(padIndex, true);
        const onUp = () => {
          window.removeEventListener('mouseup', onUp);
          this._triggerPadFromHardware(padIndex, false);
        };
        window.addEventListener('mouseup', onUp);
      });
    });

    // 4 Bottom Stop Buttons
    this.containerEl.querySelectorAll('.f1-stop-btn').forEach((stopEl) => {
      const stopIndex = Number(stopEl.getAttribute('data-stop'));
      stopEl.addEventListener('click', () => {
        if (this.midiLearnActive) {
          this.midiLearnTarget = { kind: 'stop', index: stopIndex };
          this._updateStatusBadge(`Press Stop Button ${stopIndex + 1} on F1...`);
          return;
        }
        this._toggleStopButton(stopIndex, true);
      });
    });

    // Function Buttons
    this.containerEl.querySelectorAll('.f1-fn-btn').forEach((btnEl) => {
      const btnName = btnEl.getAttribute('data-btn');
      btnEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.midiLearnActive) {
          this.midiLearnTarget = { kind: 'button', name: btnName };
          this._updateStatusBadge(`Press ${btnName.toUpperCase()} on F1...`);
          return;
        }
        this._handleFunctionButton(btnName, true);
        if (btnName === 'reverse' || btnName === 'shift') {
          const onUp = () => {
            window.removeEventListener('mouseup', onUp);
            this._handleFunctionButton(btnName, false);
          };
          window.addEventListener('mouseup', onUp);
        }
      });
    });

    // Push Rotary Encoder wheel & click
    const encEl = this.containerEl.querySelector('#f1-encoder');
    encEl?.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      this.callbacks.onEncoderDelta?.(delta, this.buttonStates.shift);
    });
    encEl?.addEventListener('click', () => {
      this._handleFunctionButton('encoderPress', true);
    });
  }
}
