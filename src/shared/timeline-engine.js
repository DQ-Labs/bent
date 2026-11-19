// Deterministic Timeline Evaluator, Live Performance Recorder,
// and FL Studio-style Piano Roll / 8-Lane Automation Editing Engine.

import { GLOBAL_MACROS } from './project-schema.js';

export const GRID_DIVISIONS = {
  bar: 4.0,     // 1 bar = 4 beats
  '1/2': 2.0,   // half note = 2 beats
  '1/4': 1.0,   // quarter note = 1 beat
  '1/8': 0.5,   // eighth note = 0.5 beat
  '1/16': 0.25, // sixteenth note = 0.25 beat
  '1/32': 0.125,// thirty-second note = 0.125 beat
  off: 0.0
};

/**
 * Convert a musical grid division ('bar', '1/4', '1/16', etc.) at a given BPM into seconds.
 */
export function gridDivisionToSeconds(bpm, division = '1/4') {
  const safeBpm = Math.max(20, Math.min(300, Number(bpm) || 120));
  const beatSec = 60 / safeBpm;
  const beats = GRID_DIVISIONS[division] ?? 0;
  return beats * beatSec;
}

/**
 * Snap a timestamp in seconds to the nearest musical grid line.
 */
export function snapTimeToGrid(time, bpm, division = '1/4', beatOffset = 0) {
  const step = gridDivisionToSeconds(bpm, division);
  if (step <= 0) {
    return Math.max(0, time);
  }
  const rel = time - beatOffset;
  const snapped = Math.round(rel / step) * step + beatOffset;
  return Math.max(0, Number(snapped.toFixed(4)));
}

/**
 * Evaluate a sorted automation breakpoint array [{ time, value }] at timestamp t.
 */
export function evaluateAutomationLaneAt(points, time, fallbackValue = 0.0) {
  if (!Array.isArray(points) || points.length === 0) {
    return fallbackValue;
  }
  if (time <= points[0].time) {
    return points[0].value;
  }
  const last = points[points.length - 1];
  if (time >= last.time) {
    return last.value;
  }
  // Binary search for surrounding interval
  let lo = 0;
  let hi = points.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= time) {
      if (mid + 1 < points.length && points[mid + 1].time > time) {
        const p0 = points[mid];
        const p1 = points[mid + 1];
        const span = p1.time - p0.time;
        if (span <= 1e-6) return p1.value;
        const alpha = (time - p0.time) / span;
        return p0.value + (p1.value - p0.value) * alpha;
      }
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return fallbackValue;
}

/**
 * Deterministically compute local video playback position within [clip.inPoint, clip.outPoint].
 */
export function computeDeterministicClipTime(clip, pad, note, timelineTime) {
  if (!clip) return 0;
  const inPt = Math.max(0, Number(clip.inPoint) || 0);
  const fullDur = Math.max(0.1, Number(clip.duration) || 10);
  const outPt = Math.max(inPt + 0.05, Math.min(fullDur, Number(clip.outPoint) || fullDur));
  const span = outPt - inPt;

  const clipSpeed = Math.max(0.05, Number(clip.speed) || 1.0);
  const padSpeed = Math.max(0.05, Number(pad?.speedMultiplier) || 1.0);
  const speed = clipSpeed * padSpeed;

  const noteStart = Number(note?.startTime) || 0;
  const slip = Number(note?.slipOffset) || 0;
  const elapsed = Math.max(0, timelineTime - noteStart) * speed + slip;

  const isReversed = Boolean(clip.reverse) !== Boolean(pad?.reverse) !== Boolean(note?.reverse);
  const loopMode = clip.loopMode || 'loop';

  let localOffset = 0;
  if (loopMode === 'oneshot') {
    localOffset = Math.min(span, Math.max(0, elapsed));
  } else if (loopMode === 'pingpong') {
    const cycle = span * 2;
    const m = ((elapsed % cycle) + cycle) % cycle;
    localOffset = m <= span ? m : cycle - m;
  } else {
    // Standard loop
    localOffset = ((elapsed % span) + span) % span;
  }

  return isReversed ? outPt - localOffset : inPt + localOffset;
}

/**
 * Evaluate the complete deterministic visual & macro state at timestamp `time` (in seconds).
 */
export function evaluateTimelineAt(take, project, time) {
  const pads = project?.pads || [];
  const clips = project?.clips || [];
  const notes = take?.notes || [];

  const activeNotes = notes.filter(
    (n) => time >= n.startTime && time < n.startTime + Math.max(0.02, n.duration)
  );

  const activePadFlags = new Array(16).fill(false);
  let activeClipNote = null;
  const activeFxNotes = [];

  for (const n of activeNotes) {
    const pad = pads[n.padIndex];
    if (!pad) continue;
    activePadFlags[n.padIndex] = true;
    if (pad.role === 'fx') {
      activeFxNotes.push(n);
    } else {
      if (!activeClipNote || n.startTime >= activeClipNote.startTime) {
        activeClipNote = n;
      }
    }
  }

  // Fallback to Pad 1 if no clip note is active at this timestamp
  const activeClipPadIndex = activeClipNote ? activeClipNote.padIndex : 0;
  const activeClipPad = pads[activeClipPadIndex] || pads[0];
  const clip = clips.find((c) => c.id === activeClipPad?.clipId) || clips[0];
  const clipTime = computeDeterministicClipTime(clip, activeClipPad, activeClipNote, time);

  // Evaluate 8 Global Circuit-Bend Macros
  const rawAutomationMacros = new Array(8).fill(0);
  const effectiveMacros = new Array(8).fill(0);

  for (let m = 0; m < 8; m++) {
    const defVal = project?.macros?.[m]?.value ?? GLOBAL_MACROS[m].defaultValue;
    const lane = take?.automation?.[m];
    const autoVal = evaluateAutomationLaneAt(lane, time, defVal);
    rawAutomationMacros[m] = Number(Math.max(0, Math.min(1, autoVal)).toFixed(4));

    // Blend automation curve + active Clip pad baseline bend signature + active FX Punch pads
    const clipSig = activeClipPad?.bendSignature?.[m] || 0;
    let fxSum = 0;
    for (const fxNote of activeFxNotes) {
      const fxPad = pads[fxNote.padIndex];
      if (fxPad?.bendSignature) {
        fxSum += fxPad.bendSignature[m] || 0;
      }
    }

    // Smooth additive saturation so faders/knobs + pad signatures combine naturally
    const combined = Math.max(0, Math.min(1, autoVal + clipSig * 0.45 + fxSum * 0.85));
    effectiveMacros[m] = Number(combined.toFixed(4));
  }

  return {
    time,
    activeClipPadIndex,
    activeClipNote,
    clip,
    clipTime,
    activeFxNotes,
    activeFxPadIndices: activeFxNotes.map((n) => n.padIndex),
    activePadFlags,
    rawAutomationMacros,
    macros: effectiveMacros
  };
}

/**
 * Sample-accurate Live Performance Recorder for Perform Mode.
 */
export class PerformanceRecorder {
  constructor(project, takeName = null) {
    this.project = project;
    this.bpm = project?.audio?.bpm || 128;
    this.takeId = `take-${Date.now()}`;
    this.takeName = takeName || `Take ${(project?.takes?.length || 0) + 1} (${this.bpm} BPM)`;
    this.notes = [];
    this.openNotesByPad = new Map();
    this.activeLatchClipPad = null;
    this.automation = Array.from({ length: 8 }, (_, m) => [
      {
        time: 0.0,
        value: project?.macros?.[m]?.value ?? GLOBAL_MACROS[m].defaultValue
      }
    ]);
    this.noteCounter = 1;
  }

  recordPadDown(padIndex, rawTime, options = {}) {
    const pad = this.project?.pads?.[padIndex];
    if (!pad) return;

    const quantize = Boolean(options.quantize || pad.quantize);
    const grid = this.project?.audio?.quantizeGrid || '1/16';
    const time = quantize
      ? snapTimeToGrid(rawTime, this.bpm, grid, this.project?.audio?.beatOffset || 0)
      : Math.max(0, Number(rawTime.toFixed(4)));

    // If this is a 'clip' pad in 'latch' mode, close any currently latched clip pad
    if (pad.role === 'clip' && pad.triggerMode === 'latch') {
      if (this.activeLatchClipPad !== null && this.activeLatchClipPad !== padIndex) {
        this._closeOpenNote(this.activeLatchClipPad, time);
      }
      this.activeLatchClipPad = padIndex;
    }

    // If the same pad already has an open note, close or toggle it
    if (this.openNotesByPad.has(padIndex)) {
      if (pad.role === 'fx' && pad.triggerMode === 'latch') {
        this._closeOpenNote(padIndex, time);
        return;
      }
      this._closeOpenNote(padIndex, time);
    }

    const note = {
      id: `${this.takeId}-n${this.noteCounter++}`,
      padIndex,
      startTime: time,
      duration: 0.25,
      slipOffset: 0.0,
      reverse: Boolean(options.reverse)
    };

    this.notes.push(note);
    this.openNotesByPad.set(padIndex, note);
  }

  recordPadUp(padIndex, rawTime) {
    const pad = this.project?.pads?.[padIndex];
    if (!pad) return;
    // Latched pads remain active until switched or explicitly stopped
    if (pad.triggerMode === 'latch') {
      return;
    }
    this._closeOpenNote(padIndex, rawTime);
  }

  _closeOpenNote(padIndex, endTime) {
    const open = this.openNotesByPad.get(padIndex);
    if (!open) return;
    open.duration = Math.max(0.05, Number((endTime - open.startTime).toFixed(4)));
    this.openNotesByPad.delete(padIndex);
  }

  recordMacroChange(macroIndex, rawTime, rawValue) {
    if (macroIndex < 0 || macroIndex >= 8) return;
    const lane = this.automation[macroIndex];
    const time = Math.max(0, Number(rawTime.toFixed(4)));
    const value = Math.max(0, Math.min(1, Number(rawValue.toFixed(4))));

    const last = lane[lane.length - 1];
    if (last) {
      if (Math.abs(time - last.time) < 0.008) {
        last.value = value;
        return;
      }
      if (Math.abs(value - last.value) < 0.002 && time - last.time < 0.12) {
        return;
      }
    }
    lane.push({ time, value });
  }

  finalize(endTime) {
    const finalDur = Math.max(1.0, Number(endTime.toFixed(4)));
    for (const padIndex of Array.from(this.openNotesByPad.keys())) {
      this._closeOpenNote(padIndex, finalDur);
    }
    for (let m = 0; m < 8; m++) {
      const lane = this.automation[m];
      lane.sort((a, b) => a.time - b.time);
      const last = lane[lane.length - 1];
      if (last && last.time < finalDur) {
        lane.push({ time: finalDur, value: last.value });
      }
    }
    return {
      id: this.takeId,
      name: this.takeName,
      createdAt: new Date().toISOString(),
      duration: finalDur,
      bpm: this.bpm,
      notes: this.notes,
      automation: this.automation
    };
  }
}

/**
 * Quantize selected (or all) Piano Roll notes to the specified musical grid division.
 */
export function quantizeTakeNotes(notes, bpm, division = '1/16', selectedIds = null, beatOffset = 0) {
  const step = gridDivisionToSeconds(bpm, division);
  if (step <= 0) return structuredClone(notes);

  const hasSelection = selectedIds && selectedIds.size > 0;
  return notes.map((n) => {
    if (hasSelection && !selectedIds.has(n.id)) {
      return { ...n };
    }
    const snappedStart = snapTimeToGrid(n.startTime, bpm, division, beatOffset);
    const snappedDur = Math.max(step, Math.round(n.duration / step) * step);
    return {
      ...n,
      startTime: snappedStart,
      duration: Number(snappedDur.toFixed(4))
    };
  });
}

/**
 * Slice a Piano Roll note at `sliceTime` into two independent blocks, preserving internal video continuity.
 */
export function sliceTakeNote(notes, noteId, sliceTime) {
  const out = [];
  for (const n of notes) {
    if (n.id !== noteId) {
      out.push({ ...n });
      continue;
    }
    const end = n.startTime + n.duration;
    if (sliceTime <= n.startTime + 0.03 || sliceTime >= end - 0.03) {
      out.push({ ...n });
      continue;
    }
    const firstDur = Number((sliceTime - n.startTime).toFixed(4));
    const secondDur = Number((end - sliceTime).toFixed(4));
    out.push({
      ...n,
      duration: firstDur
    });
    out.push({
      ...n,
      id: `${n.id}-s${Math.round(sliceTime * 1000)}`,
      startTime: Number(sliceTime.toFixed(4)),
      duration: secondDur,
      slipOffset: Number(((n.slipOffset || 0) + firstDur).toFixed(4))
    });
  }
  return out;
}

/**
 * Chop a note into a rhythmic stutter roll (FL Studio Piano Roll Chopper style),
 * resetting each slice's slipOffset so the video frame stutters on the beat!
 */
export function splitNoteIntoStutterRoll(notes, noteId, bpm, division = '1/16') {
  const step = gridDivisionToSeconds(bpm, division);
  if (step <= 0.02) return structuredClone(notes);

  const out = [];
  for (const n of notes) {
    if (n.id !== noteId || n.duration <= step * 1.1) {
      out.push({ ...n });
      continue;
    }
    let cursor = n.startTime;
    const end = n.startTime + n.duration;
    let idx = 0;
    while (cursor < end - 0.01) {
      const sliceDur = Math.min(step, end - cursor);
      out.push({
        ...n,
        id: idx === 0 ? n.id : `${n.id}-r${idx}`,
        startTime: Number(cursor.toFixed(4)),
        duration: Number(sliceDur.toFixed(4)),
        slipOffset: n.slipOffset || 0
      });
      cursor += step;
      idx++;
    }
  }
  return out;
}

/**
 * Smooth jittery hand-recorded automation points using a 3-point weighted moving average
 * while keeping endpoints anchored.
 */
export function smoothAutomationLane(points, passes = 2) {
  if (!Array.isArray(points) || points.length <= 2) {
    return structuredClone(points || []);
  }
  let curr = points.map((p) => ({ ...p }));
  for (let pass = 0; pass < passes; pass++) {
    const next = curr.map((p) => ({ ...p }));
    for (let i = 1; i < curr.length - 1; i++) {
      const avg = curr[i - 1].value * 0.25 + curr[i].value * 0.5 + curr[i + 1].value * 0.25;
      next[i].value = Number(Math.max(0, Math.min(1, avg)).toFixed(4));
    }
    curr = next;
  }
  return curr;
}

/**
 * Generate a tempo-synced LFO curve ('sine', 'saw', 'square', 'triangle') into an automation lane
 * over [startTime, endTime].
 */
export function generateAutomationLfo(
  existingPoints,
  startTime,
  endTime,
  bpm,
  division = '1/4',
  shape = 'sine',
  minVal = 0.1,
  maxVal = 0.9
) {
  const cycleSec = Math.max(0.05, gridDivisionToSeconds(bpm, division));
  const kept = (existingPoints || []).filter((p) => p.time < startTime || p.time > endTime);

  const generated = [];
  const stepSec = Math.max(0.02, cycleSec / 16);
  for (let t = startTime; t <= endTime + 1e-5; t += stepSec) {
    const clampedT = Math.min(endTime, t);
    const phase = ((clampedT - startTime) / cycleSec) % 1;
    let norm = 0.5;
    if (shape === 'sine') {
      norm = 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
    } else if (shape === 'saw') {
      norm = phase;
    } else if (shape === 'square') {
      norm = phase < 0.5 ? 1.0 : 0.0;
    } else if (shape === 'triangle') {
      norm = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    }
    const val = minVal + norm * (maxVal - minVal);
    generated.push({
      time: Number(clampedT.toFixed(4)),
      value: Number(Math.max(0, Math.min(1, val)).toFixed(4))
    });
  }

  return [...kept, ...generated].sort((a, b) => a.time - b.time);
}

/**
 * Splice a new live overdub automation segment into an existing automation lane over [startTime, endTime].
 */
export function mergeAutomationOverdub(existingPoints, overdubPoints, startTime, endTime) {
  if (!Array.isArray(overdubPoints) || overdubPoints.length === 0) {
    return structuredClone(existingPoints || []);
  }
  const kept = (existingPoints || []).filter((p) => p.time < startTime || p.time > endTime);
  return [...kept, ...overdubPoints].sort((a, b) => a.time - b.time);
}
