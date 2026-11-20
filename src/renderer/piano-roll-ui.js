// FL Studio-Style 16-Row Pad Piano Roll & 8-Lane Global Bend Macro Automation Editor
// for Bent's PLAYBACK Mode.

import { GLOBAL_MACROS } from '../shared/project-schema.js';
import {
  gridDivisionToSeconds,
  snapTimeToGrid,
  quantizeTakeNotes,
  sliceTakeNote,
  splitNoteIntoStutterRoll,
  smoothAutomationLane,
  generateAutomationLfo
} from '../shared/timeline-engine.js';

export class PianoRollTimelineUI {
  constructor(canvasEl, callbacks = {}) {
    this.canvas = canvasEl;
    this.ctx = canvasEl.getContext('2d');
    this.callbacks = callbacks;

    this.project = null;
    this.take = null;
    this.waveformPeaks = null;

    this.playheadTime = 0.0;
    this.zoomPxPerSec = 95; // Horizontal zoom
    this.scrollTimeOffset = 0.0;

    this.tool = 'select'; // 'select' | 'draw' | 'slice' | 'chop' | 'slip'
    this.gridDivision = '1/16'; // 'bar' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32' | 'off'
    this.activeMacroIndex = 0; // 0..7
    this.selectedNoteIds = new Set();

    // Layout geometry constants
    this.sidebarWidth = 168;
    this.rulerHeight = 46;
    this.padRowHeight = 22;
    this.automationHeaderHeight = 24;

    this.dragState = null;
    this._undoStack = [];
    this._redoStack = [];
    this._maxHistory = 50;

    this._bindCanvasEvents();
    this._setupResizeObserver();
  }

  setContext(project, take, waveformPeaks = null) {
    const takeChanged = this.take?.id !== take?.id;
    this.project = project;
    this.take = take;
    if (waveformPeaks) {
      this.waveformPeaks = waveformPeaks;
    }
    if (takeChanged) {
      this.selectedNoteIds.clear();
      this._undoStack = [];
      this._redoStack = [];
    }
    this.render();
  }

  _pushUndoSnapshot() {
    if (!this.take) return;
    this._undoStack.push({
      notes: structuredClone(this.take.notes || []),
      automation: structuredClone(this.take.automation || [])
    });
    if (this._undoStack.length > this._maxHistory) {
      this._undoStack.shift();
    }
    this._redoStack = [];
  }

  undo() {
    if (!this.take || this._undoStack.length === 0) return false;
    this._redoStack.push({
      notes: structuredClone(this.take.notes || []),
      automation: structuredClone(this.take.automation || [])
    });
    const prev = this._undoStack.pop();
    this.take.notes = prev.notes;
    this.take.automation = prev.automation;
    this.selectedNoteIds.clear();
    this.callbacks.onTakeModified?.(this.take);
    this.render();
    return true;
  }

  redo() {
    if (!this.take || this._redoStack.length === 0) return false;
    this._undoStack.push({
      notes: structuredClone(this.take.notes || []),
      automation: structuredClone(this.take.automation || [])
    });
    const next = this._redoStack.pop();
    this.take.notes = next.notes;
    this.take.automation = next.automation;
    this.selectedNoteIds.clear();
    this.callbacks.onTakeModified?.(this.take);
    this.render();
    return true;
  }

  setPlayhead(timeSec) {
    const nextTime = Math.max(0, Number(timeSec) || 0);
    if (Math.abs(this.playheadTime - nextTime) < 1e-4) {
      return;
    }
    this.playheadTime = nextTime;
    // Auto-scroll if playhead moves outside visible range during playback
    const viewWidthPx = Math.max(200, (this.canvas.clientWidth || 900) - this.sidebarWidth);
    const viewDuration = viewWidthPx / this.zoomPxPerSec;
    if (this.playheadTime > this.scrollTimeOffset + viewDuration * 0.92) {
      this.scrollTimeOffset = Math.max(0, this.playheadTime - viewDuration * 0.15);
    } else if (this.playheadTime < this.scrollTimeOffset) {
      this.scrollTimeOffset = Math.max(0, this.playheadTime);
    }
    this.render();
  }

  setTool(toolName) {
    this.tool = toolName;
    this.render();
  }

  setGridDivision(div) {
    this.gridDivision = div;
    this.render();
  }

  setActiveMacroIndex(macroIndex) {
    this.activeMacroIndex = Math.max(0, Math.min(7, Number(macroIndex) || 0));
    this.render();
  }

  quantizeSelectedOrAll() {
    if (!this.take || !this.project) return;
    this._pushUndoSnapshot();
    const bpm = this.project.audio.bpm || 128;
    const div = this.gridDivision === 'off' ? '1/16' : this.gridDivision;
    this.take.notes = quantizeTakeNotes(
      this.take.notes,
      bpm,
      div,
      this.selectedNoteIds.size > 0 ? this.selectedNoteIds : null,
      this.project.audio.beatOffset || 0
    );
    this.callbacks.onTakeModified?.(this.take);
    this.render();
  }

  smoothActiveMacroLane() {
    if (!this.take) return;
    this._pushUndoSnapshot();
    const lane = this.take.automation[this.activeMacroIndex] || [];
    this.take.automation[this.activeMacroIndex] = smoothAutomationLane(lane, 2);
    this.callbacks.onTakeModified?.(this.take);
    this.render();
  }

  applyLfoToActiveMacro(shape = 'sine') {
    if (!this.take || !this.project) return;
    this._pushUndoSnapshot();
    const bpm = this.project.audio.bpm || 128;
    const div = this.gridDivision === 'off' ? '1/4' : this.gridDivision;
    const dur = this.take.duration || this.project.audio.duration || 15.0;
    const lane = this.take.automation[this.activeMacroIndex] || [];
    this.take.automation[this.activeMacroIndex] = generateAutomationLfo(
      lane,
      0,
      dur,
      bpm,
      div,
      shape,
      0.08,
      0.92
    );
    this.callbacks.onTakeModified?.(this.take);
    this.render();
  }

  clearActiveMacroLane() {
    if (!this.take) return;
    this._pushUndoSnapshot();
    const defVal = GLOBAL_MACROS[this.activeMacroIndex].defaultValue;
    const dur = this.take.duration || 15.0;
    this.take.automation[this.activeMacroIndex] = [
      { time: 0.0, value: defVal },
      { time: dur, value: defVal }
    ];
    this.callbacks.onTakeModified?.(this.take);
    this.render();
  }

  deleteSelectedNotes() {
    if (!this.take || this.selectedNoteIds.size === 0) return;
    this._pushUndoSnapshot();
    this.take.notes = this.take.notes.filter((n) => !this.selectedNoteIds.has(n.id));
    this.selectedNoteIds.clear();
    this.callbacks.onTakeModified?.(this.take);
    this.render();
  }

  _setupResizeObserver() {
    const ro = new ResizeObserver(() => {
      this._syncCanvasSize();
      this.render();
    });
    if (this.canvas.parentElement) {
      ro.observe(this.canvas.parentElement);
    }
  }

  _syncCanvasSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(600, Math.floor(rect.width));
    const h = Math.max(420, Math.floor(rect.height));
    if (this.canvas.width !== Math.floor(w * dpr) || this.canvas.height !== Math.floor(h * dpr)) {
      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
    }
    this.logicalWidth = w;
    this.logicalHeight = h;
    // Dynamically adjust row height so 16 rows + ruler + automation lane fit cleanly
    const availForRows = Math.max(256, Math.min(384, Math.floor((h - this.rulerHeight - 135) / 16) * 16));
    this.padRowHeight = Math.floor(availForRows / 16);
  }

  timeToX(timeSec) {
    return this.sidebarWidth + (timeSec - this.scrollTimeOffset) * this.zoomPxPerSec;
  }

  xToTime(xPx) {
    return Math.max(0, this.scrollTimeOffset + (xPx - this.sidebarWidth) / this.zoomPxPerSec);
  }

  render() {
    if (!this.logicalWidth) {
      this._syncCanvasSize();
    }
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.logicalWidth;
    const h = this.logicalHeight;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background fill
    ctx.fillStyle = '#0b0d14';
    ctx.fillRect(0, 0, w, h);

    const gridTop = this.rulerHeight;
    const gridHeight = this.padRowHeight * 16;
    const autoHeaderTop = gridTop + gridHeight;
    const autoTop = autoHeaderTop + this.automationHeaderHeight;
    const autoHeight = Math.max(70, h - autoTop - 6);

    // 1. Draw 16 Pad Row Backgrounds
    const pads = this.project?.pads || [];
    for (let r = 0; r < 16; r++) {
      const y = gridTop + r * this.padRowHeight;
      ctx.fillStyle = r % 2 === 0 ? '#10131d' : '#0d1018';
      ctx.fillRect(this.sidebarWidth, y, w - this.sidebarWidth, this.padRowHeight);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.beginPath();
      ctx.moveTo(this.sidebarWidth, y + this.padRowHeight);
      ctx.lineTo(w, y + this.padRowHeight);
      ctx.stroke();
    }

    // 2. Draw Vertical Musical Beat / Bar Grid Lines across Ruler, Piano Roll & Automation
    this._drawBeatGrid(ctx, w, h, gridTop, gridHeight, autoTop, autoHeight);

    // 3. Draw Top Audio Waveform & Bar/Beat Ruler
    this._drawRulerAndWaveform(ctx, w);

    // 4. Draw Recorded Note Blocks inside the 16-Row Piano Roll
    this._drawPianoRollNotes(ctx, w, gridTop, gridHeight, pads);

    // 5. Draw 8-Lane Global Circuit-Bend Macro Automation Section
    this._drawAutomationSection(ctx, w, autoHeaderTop, autoTop, autoHeight);

    // 6. Draw Left Pad Header Sidebar & Automation Lane Selector Sidebar
    this._drawLeftSidebar(ctx, h, gridTop, autoHeaderTop, autoTop, autoHeight, pads);

    // 7. Draw Playhead Vertical Cursor across all lanes
    const playX = this.timeToX(this.playheadTime);
    if (playX >= this.sidebarWidth && playX <= w) {
      ctx.strokeStyle = '#00f5d4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, h);
      ctx.stroke();

      // Playhead triangle cap in ruler
      ctx.fillStyle = '#00f5d4';
      ctx.beginPath();
      ctx.moveTo(playX - 6, 0);
      ctx.lineTo(playX + 6, 0);
      ctx.lineTo(playX, 10);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  _drawBeatGrid(ctx, w, h, gridTop, gridHeight, autoTop, autoHeight) {
    const bpm = this.project?.audio?.bpm || 128;
    const beatOffset = this.project?.audio?.beatOffset || 0;
    const beatSec = 60 / bpm;
    const barSec = beatSec * 4;
    const snapSec = gridDivisionToSeconds(bpm, this.gridDivision === 'off' ? '1/16' : this.gridDivision);
    const maxTime = this.xToTime(w) + barSec;

    // Fine subdivision grid lines
    if (snapSec > 0 && snapSec * this.zoomPxPerSec >= 7) {
      const startIdx = Math.floor((this.scrollTimeOffset - beatOffset) / snapSec);
      const endIdx = Math.ceil((maxTime - beatOffset) / snapSec);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.035)';
      ctx.lineWidth = 1;
      for (let i = startIdx; i <= endIdx; i++) {
        const t = i * snapSec + beatOffset;
        if (t < 0) continue;
        const x = this.timeToX(t);
        if (x < this.sidebarWidth || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(x, gridTop);
        ctx.lineTo(x, gridTop + gridHeight);
        ctx.moveTo(x, autoTop);
        ctx.lineTo(x, autoTop + autoHeight);
        ctx.stroke();
      }
    }

    // Beat & Bar lines
    const startBeat = Math.floor((this.scrollTimeOffset - beatOffset) / beatSec);
    const endBeat = Math.ceil((maxTime - beatOffset) / beatSec);
    for (let b = startBeat; b <= endBeat; b++) {
      const t = b * beatSec + beatOffset;
      if (t < 0) continue;
      const x = this.timeToX(t);
      if (x < this.sidebarWidth || x > w) continue;
      const isBar = ((b % 4) + 4) % 4 === 0;
      ctx.strokeStyle = isBar ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.09)';
      ctx.lineWidth = isBar ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }

  _drawRulerAndWaveform(ctx, w) {
    ctx.fillStyle = '#131724';
    ctx.fillRect(this.sidebarWidth, 0, w - this.sidebarWidth, this.rulerHeight);

    // Draw Audio Track Waveform inside Ruler
    const dur = this.project?.audio?.duration || this.take?.duration || 15.0;
    if (this.waveformPeaks && this.waveformPeaks.length > 0 && dur > 0) {
      const peaks = this.waveformPeaks;
      ctx.fillStyle = 'rgba(0, 245, 212, 0.22)';
      const midY = this.rulerHeight * 0.62;
      const maxAmp = this.rulerHeight * 0.34;
      for (let i = 0; i < peaks.length; i++) {
        const t = (i / peaks.length) * dur;
        const x = this.timeToX(t);
        if (x < this.sidebarWidth || x > w) continue;
        const barW = Math.max(1.5, (dur / peaks.length) * this.zoomPxPerSec);
        const amp = peaks[i] * maxAmp;
        ctx.fillRect(x, midY - amp, barW, amp * 2);
      }
    }

    // Draw Bar & Beat Numbers
    const bpm = this.project?.audio?.bpm || 128;
    const beatOffset = this.project?.audio?.beatOffset || 0;
    const beatSec = 60 / bpm;
    const maxTime = this.xToTime(w);
    const startBeat = Math.max(0, Math.floor((this.scrollTimeOffset - beatOffset) / beatSec));
    const endBeat = Math.ceil((maxTime - beatOffset) / beatSec);

    ctx.font = 'bold 11px Consolas, monospace';
    for (let b = startBeat; b <= endBeat; b++) {
      const t = b * beatSec + beatOffset;
      if (t < 0) continue;
      const x = this.timeToX(t);
      if (x < this.sidebarWidth || x > w) continue;
      const barNum = Math.floor(b / 4) + 1;
      const beatInBar = (b % 4) + 1;
      if (beatInBar === 1) {
        ctx.fillStyle = '#f4f7fb';
        ctx.fillText(`BAR ${barNum}`, x + 5, 14);
      } else if (beatSec * this.zoomPxPerSec > 28) {
        ctx.fillStyle = '#73829c';
        ctx.fillText(`${barNum}.${beatInBar}`, x + 4, 14);
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.beginPath();
    ctx.moveTo(this.sidebarWidth, this.rulerHeight);
    ctx.lineTo(w, this.rulerHeight);
    ctx.stroke();
  }

  _drawPianoRollNotes(ctx, w, gridTop, _gridHeight, pads) {
    const notes = this.take?.notes || [];
    for (const note of notes) {
      const pad = pads[note.padIndex];
      const color = pad?.color || '#00f5d4';
      const x = this.timeToX(note.startTime);
      const nw = Math.max(6, note.duration * this.zoomPxPerSec);
      if (x + nw < this.sidebarWidth || x > w) continue;

      const y = gridTop + note.padIndex * this.padRowHeight + 2;
      const nh = this.padRowHeight - 4;
      const isSelected = this.selectedNoteIds.has(note.id);

      // Draw Note Block body
      ctx.fillStyle = color;
      ctx.globalAlpha = isSelected ? 0.95 : 0.78;
      ctx.beginPath();
      ctx.roundRect(x, y, nw, nh, 3);
      ctx.fill();
      ctx.globalAlpha = 1.0;

      // Border highlight
      ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      // Resize handles on left and right edges
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.fillRect(x + nw - 4, y + 2, 3, nh - 4);

      // Label inside note block
      if (nw > 34) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 3, y, nw - 8, nh);
        ctx.clip();
        ctx.fillStyle = '#06080e';
        ctx.font = 'bold 10px Inter, Segoe UI, sans-serif';
        const slipBadge = note.slipOffset ? ` [+${note.slipOffset.toFixed(2)}s]` : '';
        const revBadge = note.reverse ? ' [REV]' : '';
        ctx.fillText(`${pad?.name || `Pad ${note.padIndex + 1}`}${slipBadge}${revBadge}`, x + 5, y + nh - 5);
        ctx.restore();
      }
    }
  }

  _drawAutomationSection(ctx, w, autoHeaderTop, autoTop, autoHeight) {
    // Divider bar between Piano Roll and 8-Lane Macro Automation Editor
    ctx.fillStyle = '#171c2b';
    ctx.fillRect(this.sidebarWidth, autoHeaderTop, w - this.sidebarWidth, this.automationHeaderHeight);

    const activeMacro = GLOBAL_MACROS[this.activeMacroIndex];
    ctx.fillStyle = activeMacro.color;
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.fillText(
      `AUTOMATION LANE // ${activeMacro.name.toUpperCase()} — Click/Drag to Draw or Adjust Breakpoints`,
      this.sidebarWidth + 10,
      autoHeaderTop + 16
    );

    // Automation canvas area
    ctx.fillStyle = '#0c0f17';
    ctx.fillRect(this.sidebarWidth, autoTop, w - this.sidebarWidth, autoHeight);

    // Horizontal 25%, 50%, 75% guidelines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    for (const frac of [0.25, 0.5, 0.75]) {
      const gy = autoTop + autoHeight * (1 - frac);
      ctx.beginPath();
      ctx.moveTo(this.sidebarWidth, gy);
      ctx.lineTo(w, gy);
      ctx.stroke();
    }

    const automation = this.take?.automation || [];

    // Draw inactive macro curves faintly in background for context
    for (let m = 0; m < 8; m++) {
      if (m === this.activeMacroIndex) continue;
      const lane = automation[m];
      if (!lane || lane.length < 2) continue;
      ctx.strokeStyle = GLOBAL_MACROS[m].color;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < lane.length; i++) {
        const px = this.timeToX(lane[i].time);
        const py = autoTop + (1 - lane[i].value) * (autoHeight - 8) + 4;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1.0;

    // Draw Active Macro Lane Curve + Shaded Fill + Breakpoint Nodes
    const activeLane = automation[this.activeMacroIndex] || [];
    if (activeLane.length > 0) {
      ctx.strokeStyle = activeMacro.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let i = 0; i < activeLane.length; i++) {
        const px = this.timeToX(activeLane[i].time);
        const py = autoTop + (1 - activeLane[i].value) * (autoHeight - 8) + 4;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Fill under curve
      const firstX = this.timeToX(activeLane[0].time);
      const lastX = this.timeToX(activeLane[activeLane.length - 1].time);
      ctx.lineTo(lastX, autoTop + autoHeight);
      ctx.lineTo(firstX, autoTop + autoHeight);
      ctx.closePath();
      ctx.fillStyle = activeMacro.color;
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      // Draw breakpoint handles
      for (let i = 0; i < activeLane.length; i++) {
        const px = this.timeToX(activeLane[i].time);
        if (px < this.sidebarWidth || px > w) continue;
        const py = autoTop + (1 - activeLane[i].value) * (autoHeight - 8) + 4;
        ctx.fillStyle = '#090a0f';
        ctx.strokeStyle = activeMacro.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  _drawLeftSidebar(ctx, h, gridTop, autoHeaderTop, autoTop, autoHeight, pads) {
    // Opaque left sidebar background
    ctx.fillStyle = '#121622';
    ctx.fillRect(0, 0, this.sidebarWidth, h);

    // Top-left header box
    ctx.fillStyle = '#181d2c';
    ctx.fillRect(0, 0, this.sidebarWidth, this.rulerHeight);
    ctx.fillStyle = '#9aa8c2';
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.fillText('F1 PAD MATRIX (1-16)', 10, 20);
    ctx.fillStyle = '#00f5d4';
    ctx.fillText(`TIME: ${this.playheadTime.toFixed(2)}s`, 10, 36);

    // 16 Pad Row Headers
    for (let r = 0; r < 16; r++) {
      const pad = pads[r];
      const y = gridTop + r * this.padRowHeight;
      ctx.fillStyle = r % 2 === 0 ? '#151a28' : '#121622';
      ctx.fillRect(0, y, this.sidebarWidth, this.padRowHeight);

      // Pad Color Strip
      ctx.fillStyle = pad?.color || '#00f5d4';
      ctx.fillRect(0, y + 1, 6, this.padRowHeight - 2);

      // Pad Number & Name
      ctx.fillStyle = '#e5ecf6';
      ctx.font = 'bold 10px Inter, Segoe UI, sans-serif';
      const roleTag = pad?.role === 'fx' ? 'FX' : 'CL';
      ctx.fillText(
        `${String(r + 1).padStart(2, '0')} [${pad?.keyBinding || ''}] ${roleTag} ${pad?.name || ''}`.slice(0, 23),
        11,
        y + this.padRowHeight - 6
      );
    }

    // Automation Sidebar Header
    ctx.fillStyle = '#181d2c';
    ctx.fillRect(0, autoHeaderTop, this.sidebarWidth, this.automationHeaderHeight);
    ctx.fillStyle = '#e5ecf6';
    ctx.font = 'bold 10px Consolas, monospace';
    ctx.fillText('8 MACRO LANES (CLICK)', 10, autoHeaderTop + 15);

    // 8 Mini Macro Lane Tabs in bottom-left sidebar
    const tabH = autoHeight / 8;
    for (let m = 0; m < 8; m++) {
      const mac = GLOBAL_MACROS[m];
      const ty = autoTop + m * tabH;
      const isAct = m === this.activeMacroIndex;
      ctx.fillStyle = isAct ? '#232a3e' : '#121622';
      ctx.fillRect(0, ty, this.sidebarWidth, tabH);
      ctx.fillStyle = mac.color;
      ctx.fillRect(0, ty + 1, isAct ? 6 : 3, tabH - 2);
      ctx.fillStyle = isAct ? '#ffffff' : '#8d9bb5';
      ctx.font = isAct ? 'bold 10px Consolas, monospace' : '10px Consolas, monospace';
      const prefix = m < 4 ? `K${m + 1}` : `F${m - 3}`;
      ctx.fillText(`${prefix}: ${mac.shortName}`, 12, ty + tabH * 0.68);
    }

    // Right edge border of sidebar
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(this.sidebarWidth, 0);
    ctx.lineTo(this.sidebarWidth, h);
    ctx.stroke();
  }

  _bindCanvasEvents() {
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Wheel to zoom horizontally (or scroll with Shift)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) {
        this.scrollTimeOffset = Math.max(0, this.scrollTimeOffset + (e.deltaY > 0 ? 0.5 : -0.5));
      } else {
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const focusTime = this.xToTime(mouseX);
        const factor = e.deltaY < 0 ? 1.15 : 0.87;
        this.zoomPxPerSec = Math.max(30, Math.min(450, this.zoomPxPerSec * factor));
        if (mouseX > this.sidebarWidth) {
          this.scrollTimeOffset = Math.max(0, focusTime - (mouseX - this.sidebarWidth) / this.zoomPxPerSec);
        }
      }
      this.render();
    });

    this.canvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
    window.addEventListener('mousemove', (e) => this._onMouseMove(e));
    window.addEventListener('mouseup', () => this._onMouseUp());
  }

  _onMouseDown(e) {
    if (!this.take || !this.project) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const gridTop = this.rulerHeight;
    const gridHeight = this.padRowHeight * 16;
    const autoHeaderTop = gridTop + gridHeight;
    const autoTop = autoHeaderTop + this.automationHeaderHeight;
    const autoHeight = Math.max(70, this.logicalHeight - autoTop - 6);

    // 1. Check Left Sidebar clicks (Pad row audition or Macro lane tab selection)
    if (x < this.sidebarWidth) {
      if (y >= gridTop && y < gridTop + gridHeight) {
        const padIndex = Math.floor((y - gridTop) / this.padRowHeight);
        this.callbacks.onPadAudition?.(padIndex);
      } else if (y >= autoTop && y <= autoTop + autoHeight) {
        const macroIdx = Math.min(7, Math.max(0, Math.floor(((y - autoTop) / autoHeight) * 8)));
        this.setActiveMacroIndex(macroIdx);
        this.callbacks.onMacroLaneSelected?.(macroIdx);
      }
      return;
    }

    // 2. Check Top Ruler click/drag -> Scrub Timeline Playhead
    if (y <= this.rulerHeight) {
      const scrubTime = this.xToTime(x);
      this.dragState = { kind: 'scrub' };
      this.callbacks.onScrub?.(scrubTime);
      return;
    }

    // 3. Check 16-Row Pad Piano Roll interaction
    if (y >= gridTop && y < gridTop + gridHeight) {
      const padIndex = Math.min(15, Math.max(0, Math.floor((y - gridTop) / this.padRowHeight)));
      const clickTime = this.xToTime(x);
      const hitNote = this._findNoteAt(padIndex, clickTime);

      // Right-click deletes note (FL Studio convention)
      if (e.button === 2) {
        if (hitNote) {
          this._pushUndoSnapshot();
          this.take.notes = this.take.notes.filter((n) => n.id !== hitNote.id);
          this.selectedNoteIds.delete(hitNote.id);
          this.callbacks.onTakeModified?.(this.take);
          this.render();
        }
        return;
      }

      const beatOffset = this.project.audio.beatOffset || 0;

      if (this.tool === 'slice' && hitNote) {
        this._pushUndoSnapshot();
        const bpm = this.project.audio.bpm || 128;
        const sliceT = this.gridDivision === 'off'
          ? clickTime
          : snapTimeToGrid(clickTime, bpm, this.gridDivision, beatOffset);
        const pad = this.project.pads[hitNote.padIndex];
        const clip = this.project.clips.find((c) => c.id === pad?.clipId);
        const effectiveSpeed = (Number(clip?.speed) || 1.0) * (Number(pad?.speedMultiplier) || 1.0);
        this.take.notes = sliceTakeNote(this.take.notes, hitNote.id, sliceT, effectiveSpeed);
        this.callbacks.onTakeModified?.(this.take);
        this.render();
        return;
      }

      if (this.tool === 'chop' && hitNote) {
        this._pushUndoSnapshot();
        const bpm = this.project.audio.bpm || 128;
        const div = this.gridDivision === 'off' ? '1/16' : this.gridDivision;
        this.take.notes = splitNoteIntoStutterRoll(this.take.notes, hitNote.id, bpm, div);
        this.callbacks.onTakeModified?.(this.take);
        this.render();
        return;
      }

      if (this.tool === 'slip' && hitNote) {
        this._pushUndoSnapshot();
        this.selectedNoteIds.clear();
        this.selectedNoteIds.add(hitNote.id);
        this.dragState = {
          kind: 'slip-note',
          note: hitNote,
          startX: x,
          origSlip: hitNote.slipOffset || 0,
          dirty: false
        };
        this.render();
        return;
      }

      if (hitNote) {
        if (e.shiftKey) {
          if (this.selectedNoteIds.has(hitNote.id) && this.selectedNoteIds.size > 1) {
            this.selectedNoteIds.delete(hitNote.id);
            this.render();
            return;
          }
          this.selectedNoteIds.add(hitNote.id);
        } else if (!this.selectedNoteIds.has(hitNote.id)) {
          this.selectedNoteIds.clear();
          this.selectedNoteIds.add(hitNote.id);
        }

        const noteRightPx = this.timeToX(hitNote.startTime + hitNote.duration);
        const noteLeftPx = this.timeToX(hitNote.startTime);

        this._pushUndoSnapshot();
        if (Math.abs(x - noteRightPx) <= 8) {
          this.dragState = {
            kind: 'resize-right',
            note: hitNote,
            dirty: false
          };
        } else if (Math.abs(x - noteLeftPx) <= 7) {
          this.dragState = {
            kind: 'resize-left',
            note: hitNote,
            origEnd: hitNote.startTime + hitNote.duration,
            dirty: false
          };
        } else {
          // Move all selected notes together preserving relative offsets
          const selectedNotes = this.take.notes.filter((n) => this.selectedNoteIds.has(n.id));
          this.dragState = {
            kind: 'move-note',
            note: hitNote,
            origStart: hitNote.startTime,
            origPad: hitNote.padIndex,
            timeOffset: clickTime - hitNote.startTime,
            items: selectedNotes.map((n) => ({
              note: n,
              origStart: n.startTime,
              origPad: n.padIndex
            })),
            dirty: false
          };
        }
        this.render();
        return;
      }

      // Clicking empty space in Piano Roll:
      // Only create a new note in 'draw' mode (or double-click in 'select' mode).
      const shouldDrawNote = this.tool === 'draw' || (this.tool === 'select' && e.detail >= 2);
      if (!shouldDrawNote) {
        if (this.selectedNoteIds.size > 0) {
          this.selectedNoteIds.clear();
          this.render();
        }
        return;
      }

      this._pushUndoSnapshot();
      const bpm = this.project.audio.bpm || 128;
      const div = this.gridDivision === 'off' ? '1/8' : this.gridDivision;
      const stepSec = Math.max(0.1, gridDivisionToSeconds(bpm, div));
      const startT = this.gridDivision === 'off'
        ? clickTime
        : Math.floor((clickTime - beatOffset) / stepSec) * stepSec + beatOffset;

      const newNote = {
        id: `n-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        padIndex,
        startTime: Number(Math.max(0, startT).toFixed(4)),
        duration: Number(stepSec.toFixed(4)),
        slipOffset: 0.0,
        reverse: false
      };
      this.take.notes.push(newNote);
      this.selectedNoteIds.clear();
      this.selectedNoteIds.add(newNote.id);
      this.dragState = {
        kind: 'resize-right',
        note: newNote,
        dirty: true
      };
      this.callbacks.onTakeModified?.(this.take);
      this.render();
      return;
    }

    // 4. Check 8-Lane Macro Automation Section click/drag -> Draw/Move Breakpoints
    if (y >= autoTop && y <= autoTop + autoHeight) {
      this._pushUndoSnapshot();
      this.dragState = {
        kind: 'draw-automation',
        autoTop,
        autoHeight,
        dirty: true
      };
      this._applyAutomationPointAtMouse(x, y, autoTop, autoHeight, e.button === 2, false);
    }
  }

  _onMouseMove(e) {
    if (!this.dragState || !this.take || !this.project) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const bpm = this.project.audio.bpm || 128;
    const beatOffset = this.project.audio.beatOffset || 0;
    const snapDiv = e.altKey ? 'off' : this.gridDivision;

    if (this.dragState.kind === 'scrub') {
      const scrubTime = this.xToTime(x);
      this.callbacks.onScrub?.(scrubTime);
      return;
    }

    if (this.dragState.kind === 'move-note') {
      const anchor = this.dragState.note;
      const rawStart = Math.max(0, this.xToTime(x) - this.dragState.timeOffset);
      const nextAnchorStart = snapDiv === 'off'
        ? Number(rawStart.toFixed(4))
        : snapTimeToGrid(rawStart, bpm, snapDiv, beatOffset);
      const deltaTime = nextAnchorStart - this.dragState.origStart;

      const gridTop = this.rulerHeight;
      const row = Math.max(0, Math.min(15, Math.floor((y - gridTop) / this.padRowHeight)));
      const deltaRow = row - this.dragState.origPad;

      for (const item of this.dragState.items) {
        item.note.startTime = Number(Math.max(0, item.origStart + deltaTime).toFixed(4));
        item.note.padIndex = Math.max(0, Math.min(15, item.origPad + deltaRow));
      }
      this.dragState.dirty = true;
      this.render();
      return;
    }

    if (this.dragState.kind === 'resize-right') {
      const note = this.dragState.note;
      const rawEnd = Math.max(note.startTime + 0.04, this.xToTime(x));
      const snappedEnd = snapDiv === 'off'
        ? rawEnd
        : Math.max(note.startTime + 0.04, snapTimeToGrid(rawEnd, bpm, snapDiv, beatOffset));
      note.duration = Number((snappedEnd - note.startTime).toFixed(4));
      this.dragState.dirty = true;
      this.render();
      return;
    }

    if (this.dragState.kind === 'resize-left') {
      const note = this.dragState.note;
      const origEnd = this.dragState.origEnd;
      const rawStart = Math.max(0, Math.min(origEnd - 0.04, this.xToTime(x)));
      const snappedStart = snapDiv === 'off'
        ? rawStart
        : Math.min(origEnd - 0.04, snapTimeToGrid(rawStart, bpm, snapDiv, beatOffset));
      note.startTime = Number(snappedStart.toFixed(4));
      note.duration = Number((origEnd - note.startTime).toFixed(4));
      this.dragState.dirty = true;
      this.render();
      return;
    }

    if (this.dragState.kind === 'slip-note') {
      const note = this.dragState.note;
      const dt = (x - this.dragState.startX) / this.zoomPxPerSec;
      note.slipOffset = Number(Math.max(0, this.dragState.origSlip + dt).toFixed(4));
      this.dragState.dirty = true;
      this.render();
      return;
    }

    if (this.dragState.kind === 'draw-automation') {
      this.dragState.dirty = true;
      this._applyAutomationPointAtMouse(
        x,
        y,
        this.dragState.autoTop,
        this.dragState.autoHeight,
        false,
        false
      );
    }
  }

  _onMouseUp() {
    if (this.dragState?.dirty && this.take) {
      this.callbacks.onTakeModified?.(this.take);
    }
    this.dragState = null;
  }

  _findNoteAt(padIndex, timeSec) {
    const notes = this.take?.notes || [];
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i];
      if (n.padIndex === padIndex && timeSec >= n.startTime && timeSec <= n.startTime + n.duration) {
        return n;
      }
    }
    return null;
  }

  _applyAutomationPointAtMouse(x, y, autoTop, autoHeight, isDelete = false, notify = true) {
    if (!this.take) return;
    if (!Array.isArray(this.take.automation[this.activeMacroIndex])) {
      this.take.automation[this.activeMacroIndex] = [];
    }
    const lane = this.take.automation[this.activeMacroIndex];
    const t = Number(this.xToTime(x).toFixed(4));
    const normVal = Number(
      Math.max(0, Math.min(1, 1 - (y - (autoTop + 4)) / Math.max(10, autoHeight - 8))).toFixed(4)
    );

    const thresholdSec = 6 / this.zoomPxPerSec;
    if (isDelete) {
      this.take.automation[this.activeMacroIndex] = lane.filter((p) => Math.abs(p.time - t) > thresholdSec * 1.5);
    } else {
      const existing = lane.find((p) => Math.abs(p.time - t) <= thresholdSec);
      if (existing) {
        existing.time = t;
        existing.value = normVal;
      } else {
        lane.push({ time: t, value: normVal });
      }
      lane.sort((a, b) => a.time - b.time);
    }
    if (notify) {
      this.callbacks.onTakeModified?.(this.take);
    }
    this.render();
  }
}
