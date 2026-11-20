// Native Instruments Traktor Kontrol F1 (VID 0x17CC, PID 0x1120)
// Binary USB HID Protocol (Input Report 0x01, Output Report 0x80)
// + Default MIDI Mode Mapping & 7-Segment LED Matrix Encoder.

export const NI_VENDOR_ID = 0x17cc;
export const F1_PRODUCT_ID = 0x1120;
export const F1_INPUT_REPORT_ID = 0x01;
export const F1_OUTPUT_REPORT_ID = 0x80;
export const F1_OUTPUT_PAYLOAD_LENGTH = 80; // 81 bytes including Report ID 0x80

// 7-Segment character font map (segments: [A, B, C, D, E, F, G])
const SEVEN_SEG_FONT = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '0': [1, 1, 1, 1, 1, 1, 0],
  '1': [0, 1, 1, 0, 0, 0, 0],
  '2': [1, 1, 0, 1, 1, 0, 1],
  '3': [1, 1, 1, 1, 0, 0, 1],
  '4': [0, 1, 1, 0, 0, 1, 1],
  '5': [1, 0, 1, 1, 0, 1, 1],
  '6': [1, 0, 1, 1, 1, 1, 1],
  '7': [1, 1, 1, 0, 0, 0, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 1],
  'A': [1, 1, 1, 0, 1, 1, 1],
  'B': [0, 0, 1, 1, 1, 1, 1],
  'C': [1, 0, 0, 1, 1, 1, 0],
  'D': [0, 1, 1, 1, 1, 0, 1],
  'E': [1, 0, 0, 1, 1, 1, 1],
  'F': [1, 0, 0, 0, 1, 1, 1],
  'G': [1, 0, 1, 1, 1, 1, 0],
  'H': [0, 1, 1, 0, 1, 1, 1],
  'I': [0, 1, 1, 0, 0, 0, 0],
  'L': [0, 0, 0, 1, 1, 1, 0],
  'N': [0, 0, 1, 0, 1, 0, 1],
  'O': [0, 0, 1, 1, 1, 0, 1],
  'P': [1, 1, 0, 0, 1, 1, 1],
  'R': [0, 0, 0, 0, 1, 0, 1],
  'S': [1, 0, 1, 1, 0, 1, 1],
  'T': [0, 0, 0, 1, 1, 1, 1],
  'U': [0, 1, 1, 1, 1, 1, 0],
  '-': [0, 0, 0, 0, 0, 0, 1]
};

/**
 * Convert a hex color string (e.g. "#00f5d4" or "#0fd") to 7-bit F1 LED brightness (0x00..0x7F).
 */
export function hexToF1Rgb(hex, scale = 1.0) {
  let clean = String(hex || '#000000').replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
  }
  const num = parseInt(clean.length === 6 ? clean : '000000', 16) || 0;
  const r8 = (num >> 16) & 0xff;
  const g8 = (num >> 8) & 0xff;
  const b8 = num & 0xff;
  const clamp7 = (v) => Math.max(0, Math.min(0x7f, Math.round((v / 255) * 0x7f * scale)));
  return {
    r: clamp7(r8),
    g: clamp7(g8),
    b: clamp7(b8)
  };
}

/**
 * Normalize an incoming F1 Input Report buffer (either 21 bytes without Report ID
 * as provided by WebHID event.data, or 22 bytes with leading 0x01 Report ID).
 */
export function normalizeF1InputBytes(bufferOrView) {
  let bytes;
  if (bufferOrView instanceof DataView) {
    bytes = new Uint8Array(bufferOrView.buffer, bufferOrView.byteOffset, bufferOrView.byteLength);
  } else if (bufferOrView instanceof Uint8Array) {
    bytes = bufferOrView;
  } else if (ArrayBuffer.isView(bufferOrView)) {
    bytes = new Uint8Array(bufferOrView.buffer, bufferOrView.byteOffset, bufferOrView.byteLength);
  } else if (bufferOrView instanceof ArrayBuffer) {
    bytes = new Uint8Array(bufferOrView);
  } else if (Array.isArray(bufferOrView)) {
    bytes = Uint8Array.from(bufferOrView);
  } else {
    return null;
  }

  // If the 22-byte packet includes Report ID 0x01 at index 0, strip it so payload is 21 bytes
  if (bytes.length === 22 && bytes[0] === F1_INPUT_REPORT_ID) {
    return bytes.subarray(1);
  }
  if (bytes.length >= 21) {
    return bytes.subarray(0, 21);
  }
  return null;
}

/**
 * Parse a 21-byte (or 22-byte with 0x01 prefix) Traktor Kontrol F1 HID Input Report.
 *
 * Byte offsets (0-indexed payload after 0x01 report ID):
 *   0: Grid buttons 8..1 (bit 7 = Pad 1 .. bit 0 = Pad 8)
 *   1: Grid buttons 16..9 (bit 7 = Pad 9 .. bit 0 = Pad 16)
 *   2: Function buttons A (bit 7=Shift, 6=Reverse, 5=Type, 4=Size, 3=Browse, 2=EncoderPush)
 *   3: Function buttons B & Stop buttons (bit 7=Stop4, 6=Stop3, 5=Stop2, 4=Stop1, 3=Sync, 2=Quant, 1=Capture)
 *   4: Infinite Rotary Encoder counter (uint8 0..255)
 *   5..20: 8 x uint16LE 12-bit analog values (0..4095):
 *          Knobs 1..4 (bytes 5..12), Faders 1..4 (bytes 13..20)
 */
export function parseF1HidInputReport(input, previousEncoderByte = null) {
  const payload = normalizeF1InputBytes(input);
  if (!payload) {
    return null;
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  // 16 Pads (Pads 0..7 in payload[0], Pads 8..15 in payload[1])
  const pads = new Array(16).fill(false);
  const b0 = payload[0];
  const b1 = payload[1];
  for (let i = 0; i < 8; i++) {
    pads[i] = Boolean((b0 >> (7 - i)) & 0x01);
    pads[8 + i] = Boolean((b1 >> (7 - i)) & 0x01);
  }

  const fnA = payload[2];
  const fnB = payload[3];

  const buttons = {
    shift: Boolean(fnA & 0x80),
    reverse: Boolean(fnA & 0x40),
    type: Boolean(fnA & 0x20),
    size: Boolean(fnA & 0x10),
    browse: Boolean(fnA & 0x08),
    encoderPress: Boolean(fnA & 0x04),
    stop1: Boolean(fnB & 0x10),
    stop2: Boolean(fnB & 0x20),
    stop3: Boolean(fnB & 0x40),
    stop4: Boolean(fnB & 0x80),
    sync: Boolean(fnB & 0x08),
    quant: Boolean(fnB & 0x04),
    capture: Boolean(fnB & 0x02)
  };

  const stops = [buttons.stop1, buttons.stop2, buttons.stop3, buttons.stop4];

  const encoderByte = payload[4];
  let encoderDelta = 0;
  if (typeof previousEncoderByte === 'number') {
    let diff = encoderByte - previousEncoderByte;
    if (diff > 128) diff -= 256;
    if (diff < -128) diff += 256;
    encoderDelta = diff;
  }

  const readAnalog12Bit = (byteOffset) => {
    const raw = view.getUint16(byteOffset, true);
    const clamped = Math.max(0, Math.min(4095, raw));
    return Number((clamped / 4095).toFixed(4));
  };

  const knobs = [
    readAnalog12Bit(5),
    readAnalog12Bit(7),
    readAnalog12Bit(9),
    readAnalog12Bit(11)
  ];

  const faders = [
    readAnalog12Bit(13),
    readAnalog12Bit(15),
    readAnalog12Bit(17),
    readAnalog12Bit(19)
  ];

  // Combined 8 Global Macros: indices 0..3 = Knobs 1..4, indices 4..7 = Faders 1..4
  const macros = [...knobs, ...faders];

  return {
    pads,
    buttons,
    stops,
    encoderByte,
    encoderDelta,
    knobs,
    faders,
    macros
  };
}

/**
 * Build the 80-byte payload for Traktor Kontrol F1 Output Report 0x80.
 * (Pass to `hidDevice.sendReport(0x80, payload)`).
 *
 * Layout of the 80 payload bytes (corresponding to Report 0x80 bytes 1..80):
 *   0..6:   Left 7-segment display (7 bytes, 0x00..0x7F)
 *   7:      Left decimal dot (1 byte)
 *   8..14:  Right 7-segment display (7 bytes, 0x00..0x7F)
 *   15:     Right decimal dot (1 byte)
 *   16..23: Function button LEDs: Browse, Size, Type, Reverse, Shift, Capture, Quant, Sync
 *   24..71: 16 Grid Pads x 3 bytes (R, G, B brightness 0x00..0x7F)
 *   72..79: 4 Bottom Stop buttons x 2 bytes (Button 4 L/R, Button 3 L/R, Button 2 L/R, Button 1 L/R)
 */
export function buildF1HidOutputPayload(state = {}) {
  const payload = new Uint8Array(F1_OUTPUT_PAYLOAD_LENGTH);

  // 1. 2-Digit 7-Segment Display
  const text = String(state.displayText ?? '01').toUpperCase().padStart(2, ' ').slice(0, 2);
  const leftSegs = SEVEN_SEG_FONT[text[0]] || SEVEN_SEG_FONT[' '];
  const rightSegs = SEVEN_SEG_FONT[text[1]] || SEVEN_SEG_FONT[' '];

  for (let s = 0; s < 7; s++) {
    payload[s] = leftSegs[s] ? 0x7f : 0x00;
    payload[8 + s] = rightSegs[s] ? 0x7f : 0x00;
  }
  payload[7] = state.leftDot ? 0x7f : 0x00;
  payload[15] = state.rightDot ? 0x7f : 0x00;

  // 2. Function Button LEDs (indices 16..23)
  const fnLeds = state.buttons || {};
  payload[16] = fnLeds.browse ? 0x7f : 0x10;
  payload[17] = fnLeds.size ? 0x7f : 0x10;
  payload[18] = fnLeds.type ? 0x7f : 0x10;
  payload[19] = fnLeds.reverse ? 0x7f : 0x10;
  payload[20] = fnLeds.shift ? 0x7f : 0x10;
  payload[21] = fnLeds.capture ? 0x7f : 0x15;
  payload[22] = fnLeds.quant ? 0x7f : 0x10;
  payload[23] = fnLeds.sync ? 0x7f : 0x10;

  // 3. 16 RGB Pads (indices 24..71, 3 bytes per pad)
  // Native Instruments Traktor Kontrol F1 Report 0x80 orders pad LED channels as B, R, G.
  const padColors = state.padColors || [];
  const activePads = state.activePads || [];
  const colorOrder = state.padColorOrder || 'brg';
  for (let i = 0; i < 16; i++) {
    const hex = padColors[i] || '#00f5d4';
    const isActive = Boolean(activePads[i]);
    const scale = isActive ? 1.0 : 0.22;
    const { r, g, b } = hexToF1Rgb(hex, scale);
    const base = 24 + i * 3;
    if (colorOrder === 'rgb') {
      payload[base] = r;
      payload[base + 1] = g;
      payload[base + 2] = b;
    } else {
      payload[base] = b;
      payload[base + 1] = r;
      payload[base + 2] = g;
    }
  }

  // 4. 4 Bottom Stop Buttons (indices 72..79, ordered Stop 4 down to Stop 1)
  const stops = state.stops || [false, false, false, false];
  for (let col = 0; col < 4; col++) {
    // Button 4 is at 72..73, Button 1 is at 78..79
    const stopIndex = 3 - col;
    const val = stops[stopIndex] ? 0x7f : 0x12;
    payload[72 + col * 2] = val;
    payload[72 + col * 2 + 1] = val;
  }

  return payload;
}

/**
 * Default MIDI Mapping for Traktor Kontrol F1 when running in NI MIDI Mode (SHIFT + BROWSE).
 * Can be customized at runtime via Bent's 1-click MIDI Learn.
 */
export function createDefaultF1MidiMap() {
  return {
    // 16 Grid Pads: MIDI Notes 36..51 (C2..D#3) on any channel
    padNotes: [
      36, 37, 38, 39,
      40, 41, 42, 43,
      44, 45, 46, 47,
      48, 49, 50, 51
    ],
    // 4 Knobs (CC 2..5) + 4 Faders (CC 6..9) -> 8 Global Macros
    macroCCs: [2, 3, 4, 5, 6, 7, 8, 9],
    // Bottom 4 Stop Buttons: CCs 10..13 (or Notes 52..55)
    stopCCs: [10, 11, 12, 13],
    // Function Buttons
    buttonCCs: {
      capture: 14,
      quant: 15,
      sync: 16,
      reverse: 17,
      type: 18,
      size: 19,
      browse: 20,
      encoder: 41
    }
  };
}

/**
 * Parse a 3-byte standard MIDI message [status, data1, data2] against the F1 MIDI map.
 */
export function parseF1MidiMessage(data, midiMap = createDefaultF1MidiMap()) {
  if (!data || data.length < 3) {
    return null;
  }
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const d1 = data[1];
  const d2 = data[2];

  // Note On / Note Off
  if (status === 0x90 || status === 0x80) {
    const isPressed = status === 0x90 && d2 > 0;
    const padIndex = midiMap.padNotes.indexOf(d1);
    if (padIndex !== -1) {
      return {
        type: isPressed ? 'pad-down' : 'pad-up',
        padIndex,
        velocity: d2 / 127,
        raw: { status, channel, d1, d2 }
      };
    }
  }

  // Control Change (CC)
  if (status === 0xb0) {
    // Check 8 Global Macros (Knobs 1-4, Faders 1-4)
    const macroIndex = midiMap.macroCCs.indexOf(d1);
    if (macroIndex !== -1) {
      return {
        type: 'macro-change',
        macroIndex,
        value: Number((d2 / 127).toFixed(4)),
        raw: { status, channel, d1, d2 }
      };
    }

    // Check 16 pads if configured as CC buttons in NI Controller Editor
    const padCcIndex = midiMap.padNotes.indexOf(d1);
    if (padCcIndex !== -1 && !midiMap.macroCCs.includes(d1)) {
      return {
        type: d2 > 0 ? 'pad-down' : 'pad-up',
        padIndex: padCcIndex,
        velocity: d2 / 127,
        raw: { status, channel, d1, d2 }
      };
    }

    // Check 4 Stop buttons
    const stopIndex = midiMap.stopCCs.indexOf(d1);
    if (stopIndex !== -1) {
      return {
        type: 'stop-button',
        stopIndex,
        pressed: d2 > 0,
        raw: { status, channel, d1, d2 }
      };
    }

    // Check Function buttons & Encoder
    for (const [btnName, ccNum] of Object.entries(midiMap.buttonCCs || {})) {
      if (d1 === ccNum) {
        if (btnName === 'encoder') {
          // Relative or absolute encoder CC
          const delta = d2 > 64 ? d2 - 128 : d2 === 63 ? -1 : d2 === 65 ? 1 : d2 > 0 ? 1 : -1;
          return {
            type: 'encoder-step',
            delta,
            raw: { status, channel, d1, d2 }
          };
        }
        return {
          type: 'function-button',
          button: btnName,
          pressed: d2 > 0,
          raw: { status, channel, d1, d2 }
        };
      }
    }
  }

  return {
    type: 'unmapped',
    raw: { status, channel, d1, d2 }
  };
}
