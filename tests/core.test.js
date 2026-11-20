import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultProject,
  validateAndNormalizeProject,
  GLOBAL_MACROS
} from '../src/shared/project-schema.js';

import {
  F1_INPUT_REPORT_ID,
  F1_OUTPUT_PAYLOAD_LENGTH,
  hexToF1Rgb,
  parseF1HidInputReport,
  buildF1HidOutputPayload,
  parseF1MidiMessage,
  createDefaultF1MidiMap
} from '../src/shared/f1-hid-protocol.js';

import {
  evaluateTimelineAt,
  PerformanceRecorder,
  quantizeTakeNotes,
  sliceTakeNote,
  splitNoteIntoStutterRoll,
  smoothAutomationLane,
  generateAutomationLfo,
  mergeAutomationOverdub
} from '../src/shared/timeline-engine.js';

test('Project Schema: creates 16 pads, 8 global circuit-bend macros, and demo take', () => {
  const proj = createDefaultProject();
  assert.equal(proj.pads.length, 16);
  assert.equal(proj.macros.length, 8);
  assert.equal(GLOBAL_MACROS.length, 8);
  assert.equal(proj.takes.length, 1);

  // Verify Option B roles: 12 clip pads + 4 FX punch pads by default
  const clipPads = proj.pads.filter((p) => p.role === 'clip');
  const fxPads = proj.pads.filter((p) => p.role === 'fx');
  assert.equal(clipPads.length, 12);
  assert.equal(fxPads.length, 4);

  // Validate round-trip normalization
  const normalized = validateAndNormalizeProject({ name: 'Custom Session', canvas: { width: 640, height: 480 } });
  assert.equal(normalized.name, 'Custom Session');
  assert.equal(normalized.canvas.width, 640);
  assert.equal(normalized.pads.length, 16);
});

test('Traktor Kontrol F1 HID Protocol: parses 22-byte Report 0x01 and builds 80-byte Report 0x80 payload', () => {
  const buf = new Uint8Array(22);
  buf[0] = F1_INPUT_REPORT_ID;
  buf[1] = 0b10000001; // Pad 1 (bit 7) and Pad 8 (bit 0) pressed
  buf[2] = 0b00000001; // Pad 16 (bit 0) pressed
  buf[3] = 0x80 | 0x40; // SHIFT + REVERSE pressed
  buf[4] = 0x02 | 0x04 | 0x10; // CAPTURE + QUANT + STOP 1 pressed
  buf[5] = 10; // Encoder byte

  const view = new DataView(buf.buffer);
  // Knob 1 at payload offset 5 -> buffer offset 6 = 4095 (1.0)
  view.setUint16(6, 4095, true);
  // Fader 1 at payload offset 13 -> buffer offset 14 = 2048 (~0.5001)
  view.setUint16(14, 2048, true);

  const parsed = parseF1HidInputReport(buf, 8);
  assert.ok(parsed);
  assert.equal(parsed.pads[0], true);  // Pad 1
  assert.equal(parsed.pads[7], true);  // Pad 8
  assert.equal(parsed.pads[15], true); // Pad 16
  assert.equal(parsed.pads[1], false);
  assert.equal(parsed.buttons.shift, true);
  assert.equal(parsed.buttons.reverse, true);
  assert.equal(parsed.buttons.capture, true);
  assert.equal(parsed.buttons.quant, true);
  assert.equal(parsed.stops[0], true);
  assert.equal(parsed.encoderDelta, 2);
  assert.equal(parsed.knobs[0], 1.0);
  assert.ok(Math.abs(parsed.faders[0] - 0.5001) < 0.001);
  assert.equal(parsed.macros.length, 8);

  const outPayload = buildF1HidOutputPayload({
    displayText: '16',
    leftDot: true,
    padColors: Array(16).fill('#00f5d4'),
    activePads: parsed.pads,
    stops: [true, false, false, false]
  });
  assert.equal(outPayload.length, F1_OUTPUT_PAYLOAD_LENGTH);
  assert.equal(outPayload[7], 0x7f); // Left dot active
});

test('Traktor Kontrol F1 MIDI Mode Fallback: parses pad notes and 8 macro CCs', () => {
  const map = createDefaultF1MidiMap();
  const noteOn = parseF1MidiMessage(new Uint8Array([0x90, 36, 100]), map);
  assert.equal(noteOn.type, 'pad-down');
  assert.equal(noteOn.padIndex, 0);

  const faderCC = parseF1MidiMessage(new Uint8Array([0xb0, 6, 127]), map);
  assert.equal(faderCC.type, 'macro-change');
  assert.equal(faderCC.macroIndex, 4); // Fader 1 = Macro 4
  assert.equal(faderCC.value, 1.0);
});

test('Timeline Engine: records live performance take, evaluates deterministically, and edits Piano Roll', () => {
  const proj = createDefaultProject();
  const rec = new PerformanceRecorder(proj, 'Live Jam Test');

  // Trigger Pad 1 (latch clip) at t=0.0, switch to Pad 3 at t=1.0, hold FX Pad 13 from 0.5..0.8
  rec.recordPadDown(0, 0.0);
  rec.recordMacroChange(0, 0.0, 0.1);
  rec.recordMacroChange(0, 0.5, 0.8);
  rec.recordPadDown(12, 0.5); // Pad 13 (index 12) is FX Punch ('gate')
  rec.recordPadUp(12, 0.8);
  rec.recordPadDown(2, 1.0); // Pad 3 switches latch clip from Pad 1 -> Pad 3
  const take = rec.finalize(2.0);

  assert.equal(take.notes.length, 3);
  // At t=0.6, Pad 1 (index 0) and FX Pad 13 (index 12) should both be active!
  const stateAt06 = evaluateTimelineAt(take, proj, 0.6);
  assert.equal(stateAt06.activeClipPadIndex, 0);
  assert.deepEqual(stateAt06.activeFxPadIndices, [12]);
  assert.ok(stateAt06.macros[0] > 0.7);

  // At t=1.2, Pad 3 (index 2) is the active clip pad
  const stateAt12 = evaluateTimelineAt(take, proj, 1.2);
  assert.equal(stateAt12.activeClipPadIndex, 2);
  assert.deepEqual(stateAt12.activeFxPadIndices, []);

  // Test slicing a note in the Piano Roll
  const sliced = sliceTakeNote(take.notes, take.notes[2].id, 1.5);
  assert.equal(sliced.length, 4);

  // Test stutter roll chopper
  const chopped = splitNoteIntoStutterRoll(take.notes, take.notes[0].id, 120, '1/8');
  assert.ok(chopped.length > take.notes.length);

  // Test quantization, smoothing, and LFO generation
  const quantized = quantizeTakeNotes(take.notes, 128, '1/16');
  assert.equal(quantized.length, take.notes.length);

  const lfoLane = generateAutomationLfo(take.automation[0], 0, 2.0, 120, '1/4', 'sine', 0.2, 0.8);
  assert.ok(lfoLane.length > 5);
  const smoothed = smoothAutomationLane(lfoLane, 2);
  assert.equal(smoothed.length, lfoLane.length);
});

test('Project Schema: normalizes malformed takes, missing automation lanes, and preserves midiMap', () => {
  const normalized = validateAndNormalizeProject({
    takes: [
      {
        id: 'corrupt-take',
        name: 'Partial Take',
        notes: [
          { padIndex: 99, startTime: -2, duration: 0 },
          null
        ],
        automation: [[{ time: 1.5, value: 2.5 }, { time: 0.2, value: -1 }]]
      }
    ],
    midiMap: { padNotes: Array.from({ length: 16 }, (_, i) => 60 + i) }
  });

  assert.equal(normalized.takes.length, 1);
  const take = normalized.takes[0];
  assert.equal(take.notes.length, 1);
  assert.equal(take.notes[0].padIndex, 15);
  assert.equal(take.notes[0].startTime, 0);
  assert.ok(take.notes[0].duration >= 0.02);
  assert.equal(take.automation.length, 8);
  assert.equal(take.automation[0][0].time, 0.2);
  assert.equal(take.automation[0][0].value, 0);
  assert.equal(take.automation[0][1].value, 1);
  assert.equal(take.automation[7].length, 2);
  assert.equal(normalized.midiMap.padNotes[0], 60);
});

test('F1 HID Protocol: 7-seg glyphs (SN/RE/ED/PF/PB), BRG pad byte order, 3-digit hex, and encoder wraparound', () => {
  // 3-digit hex expansion
  const c3 = hexToF1Rgb('#f08', 1.0);
  const c6 = hexToF1Rgb('#ff0088', 1.0);
  assert.deepEqual(c3, c6);

  // 'SN' snapshot display should light segments on both left and right digits
  const snPayload = buildF1HidOutputPayload({
    displayText: 'SN',
    padColors: ['#ff0080', ...Array(15).fill('#000000')],
    activePads: [true, ...Array(15).fill(false)]
  });
  const leftLit = snPayload.slice(0, 7).some((v) => v > 0);
  const rightLit = snPayload.slice(8, 15).some((v) => v > 0);
  assert.equal(leftLit, true);
  assert.equal(rightLit, true);

  // Default BRG byte order for Pad 1 (#ff0080 -> R=0x7f, G=0x00, B=0x40 -> bytes [B, R, G])
  assert.equal(snPayload[24], 0x40); // B
  assert.equal(snPayload[25], 0x7f); // R
  assert.equal(snPayload[26], 0x00); // G

  // Explicit RGB option
  const rgbPayload = buildF1HidOutputPayload({
    padColorOrder: 'rgb',
    padColors: ['#ff0080', ...Array(15).fill('#000000')],
    activePads: [true, ...Array(15).fill(false)]
  });
  assert.equal(rgbPayload[24], 0x7f); // R
  assert.equal(rgbPayload[25], 0x00); // G
  assert.equal(rgbPayload[26], 0x40); // B

  // Encoder wraparound 255 -> 0 (+1) and 0 -> 255 (-1)
  const pktZero = new Uint8Array(21);
  pktZero[4] = 0;
  assert.equal(parseF1HidInputReport(pktZero, 255).encoderDelta, 1);

  const pkt255 = new Uint8Array(21);
  pkt255[4] = 255;
  assert.equal(parseF1HidInputReport(pkt255, 0).encoderDelta, -1);
});

test('Timeline Engine: sliceTakeNote scales slipOffset by speed, oneshot pads ignore padUp, and mergeAutomationOverdub splices cleanly', () => {
  const notes = [{ id: 'n1', padIndex: 8, startTime: 1.0, duration: 2.0, slipOffset: 0.5, reverse: false }];
  const sliced = sliceTakeNote(notes, 'n1', 1.75, 2.0);
  assert.equal(sliced.length, 2);
  assert.equal(sliced[0].duration, 0.75);
  assert.equal(sliced[1].startTime, 1.75);
  assert.equal(sliced[1].duration, 1.25);
  // 0.5 original slip + 0.75 timeline sec * 2.0 speed = 2.0s clip time
  assert.equal(sliced[1].slipOffset, 2.0);

  // One-shot trigger mode should not truncate note on padUp
  const proj = createDefaultProject();
  proj.pads[0].triggerMode = 'oneshot';
  const rec = new PerformanceRecorder(proj, 'OneShot Test');
  rec.recordPadDown(0, 0.0);
  rec.recordPadUp(0, 0.06);
  const take = rec.finalize(4.0);
  assert.equal(take.notes.length, 1);
  assert.ok(take.notes[0].duration > 0.5);

  // mergeAutomationOverdub replaces points inside [1.0, 2.0] and keeps outside points
  const baseLane = [
    { time: 0.0, value: 0.1 },
    { time: 1.5, value: 0.9 },
    { time: 3.0, value: 0.2 }
  ];
  const merged = mergeAutomationOverdub(baseLane, [{ time: 1.5, value: 0.4 }], 1.0, 2.0);
  assert.deepEqual(merged, [
    { time: 0.0, value: 0.1 },
    { time: 1.5, value: 0.4 },
    { time: 3.0, value: 0.2 }
  ]);
});
