// WebGL2 Multi-Pass Circuit-Bend Shader Compositor + Ping-Pong Framebuffer Pipeline
// + 6 Built-in Procedural Analog Video Synth Sources & Local Video Clip Pool.

const VERTEX_SHADER_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

// Pass 1: Analog & Digital Circuit-Bend Synthesis into Ping-Pong FBO
const BEND_FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_sourceTex;
uniform sampler2D u_feedbackTex;
uniform sampler2D u_moshTex;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_dt;
uniform float u_macros[8]; // 0..3 = Knobs 1..4, 4..7 = Faders 1..4
uniform vec4 u_fft;        // x=sub, y=kick, z=mid, w=high
uniform float u_columnKill[4]; // 1.0 if column killed/bypassed

// Fast deterministic hash
float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// NTSC RGB <-> YIQ conversion
vec3 rgb2yiq(vec3 c) {
  return vec3(
    0.299 * c.r + 0.587 * c.g + 0.114 * c.b,
    0.596 * c.r - 0.274 * c.g - 0.322 * c.b,
    0.211 * c.r - 0.523 * c.g + 0.312 * c.b
  );
}

vec3 yiq2rgb(vec3 yiq) {
  return vec3(
    yiq.x + 0.956 * yiq.y + 0.621 * yiq.z,
    yiq.x - 0.272 * yiq.y - 0.647 * yiq.z,
    yiq.x - 1.106 * yiq.y + 1.703 * yiq.z
  );
}

// Analog op-amp triangle wavefolder
vec3 wavefold(vec3 x, float drive) {
  if (drive <= 0.001) return x;
  float gain = 1.0 + drive * 5.5;
  vec3 v = x * gain;
  vec3 folded = abs(fract(v * 0.5 + 0.25) * 2.0 - 1.0);
  return mix(x, folded, min(1.0, drive * 1.35));
}

void main() {
  // Flip Y only when sampling HTML canvas texture at the end; inside FBO space v_uv is 0..1
  vec2 uv = v_uv;

  // Read 8 Global Circuit-Bend Macros (respecting column bypass buttons 1..4)
  float col1 = 1.0 - u_columnKill[0];
  float col2 = 1.0 - u_columnKill[1];
  float col3 = 1.0 - u_columnKill[2];
  float col4 = 1.0 - u_columnKill[3];

  float mChromaPhase = u_macros[0] * col1;
  float mWavefold    = u_macros[4] * col1;

  float mHSyncTear   = u_macros[1] * col2;
  float mWobbulator  = u_macros[5] * col2;

  float mFbackWarp   = u_macros[2] * col3;
  float mFbackMix    = u_macros[6] * col3;

  float mPixelMelt   = u_macros[3] * col4;
  float mMoshHold    = u_macros[7] * col4;

  // --- COLUMN 4A: Pixel Melt & Macroblock Quantization ---
  if (mPixelMelt > 0.01) {
    float blocks = mix(240.0, 22.0, pow(mPixelMelt, 0.75));
    vec2 blockId = floor(uv * blocks);
    float blockNoise = hash21(blockId + floor(u_time * 8.0));
    if (blockNoise < mPixelMelt * 0.45) {
      uv = (blockId + 0.5) / blocks;
    }
  }

  // --- COLUMN 2A: CRT H-Sync Tear & VHS Tracking Bar ---
  float scanlineY = floor(uv.y * u_resolution.y * 0.5);
  float syncStatic = 0.0;
  if (mHSyncTear > 0.005) {
    float lineRand = hash11(scanlineY + floor(u_time * 45.0));
    float tearWave = sin(uv.y * 28.0 + u_time * 9.0) * cos(uv.y * 73.0 - u_time * 14.0);
    float burst = step(1.0 - mHSyncTear * 0.35, lineRand) * (lineRand - 0.5) * 0.25 * mHSyncTear;
    uv.x += tearWave * 0.045 * mHSyncTear + burst;

    // VHS tracking bar drifting down screen
    float barCenter = fract(u_time * 0.22);
    float barDist = abs(uv.y - barCenter);
    if (barDist < 0.06 * mHSyncTear) {
      float barIntensity = 1.0 - (barDist / (0.06 * mHSyncTear));
      uv.x += (hash21(vec2(scanlineY, u_time)) - 0.5) * 0.18 * barIntensity;
      syncStatic = barIntensity * mHSyncTear * 0.65;
    }

    // Vertical hold bounce at high tear
    if (mHSyncTear > 0.55) {
      uv.y = fract(uv.y + sin(u_time * 12.0) * (mHSyncTear - 0.55) * 0.15);
    }
  }

  // --- COLUMN 2B: Rutt-Etra Scanline Wobbulator ---
  if (mWobbulator > 0.005) {
    vec2 probeUv = vec2(clamp(uv.x, 0.0, 1.0), 1.0 - clamp(uv.y, 0.0, 1.0));
    vec3 probeCol = texture(u_sourceTex, probeUv).rgb;
    float probeLuma = dot(probeCol, vec3(0.299, 0.587, 0.114));

    float audioPulse = 1.0 + u_fft.x * 1.4 + u_fft.y * 1.2;
    float wobbleX = sin(uv.y * 45.0 + u_time * 7.0 + probeLuma * 8.0) * 0.055 * mWobbulator * audioPulse;
    float ruttY = (probeLuma - 0.5) * 0.12 * mWobbulator * audioPulse;
    uv.x += wobbleX;
    uv.y = clamp(uv.y + ruttY, 0.0, 1.0);
  }

  // Sample current video source (note: canvas texture has top-left origin so flip Y)
  vec2 srcUv = vec2(fract(uv.x), 1.0 - clamp(uv.y, 0.0, 1.0));
  vec3 srcColor = texture(u_sourceTex, srcUv).rgb;

  // Threshold Pixel Melt scanline smear
  if (mPixelMelt > 0.01) {
    float luma = dot(srcColor, vec3(0.299, 0.587, 0.114));
    float meltSpan = mPixelMelt * 0.12;
    vec3 leftSample = texture(u_sourceTex, vec2(fract(srcUv.x - meltSpan * luma), srcUv.y)).rgb;
    vec3 rightSample = texture(u_sourceTex, vec2(fract(srcUv.x + meltSpan * (1.0 - luma)), srcUv.y)).rgb;
    srcColor = mix(srcColor, max(leftSample, rightSample), mPixelMelt * 0.75);
  }

  // --- COLUMN 1A: YIQ Chroma Phase & NTSC Cross-Bleed ---
  if (mChromaPhase > 0.005) {
    float chromaShift = mChromaPhase * 0.04;
    vec3 leftRgb = texture(u_sourceTex, vec2(fract(srcUv.x - chromaShift), srcUv.y)).rgb;
    vec3 rightRgb = texture(u_sourceTex, vec2(fract(srcUv.x + chromaShift), srcUv.y)).rgb;

    vec3 yiqCenter = rgb2yiq(srcColor);
    vec3 yiqLeft = rgb2yiq(leftRgb);
    vec3 yiqRight = rgb2yiq(rightRgb);

    float phaseAngle = mChromaPhase * 6.2831853 + sin(uv.y * 160.0 + u_time * 15.0) * mChromaPhase * 1.8;
    float c = cos(phaseAngle);
    float s = sin(phaseAngle);

    float iChan = yiqLeft.y * c - yiqRight.z * s;
    float qChan = yiqLeft.y * s + yiqRight.z * c;

    // Cross-modulate high-frequency NTSC carrier stripes into chroma
    float carrier = sin(uv.x * u_resolution.x * 0.35 + uv.y * 120.0 + u_time * 20.0) * 0.22 * mChromaPhase;
    vec3 bentYiq = vec3(yiqCenter.x, iChan + carrier, qChan - carrier);
    srcColor = clamp(yiq2rgb(bentYiq), 0.0, 1.0);
  }

  // --- COLUMN 1B: Analog Op-Amp Wavefolder ---
  if (mWavefold > 0.005) {
    srcColor = wavefold(srcColor, mWavefold);
  }

  // Add VHS sync tracking snow if active
  if (syncStatic > 0.01) {
    float snow = hash21(uv * u_resolution + u_time * 100.0);
    srcColor = mix(srcColor, vec3(snow), syncStatic);
  }

  // --- COLUMN 4B: Luma-Key Datamosh Smear ---
  if (mMoshHold > 0.01) {
    float srcLuma = dot(srcColor, vec3(0.299, 0.587, 0.114));
    vec2 moshOffset = vec2(
      dFdx(srcLuma) * 18.0 * mMoshHold,
      dFdy(srcLuma) * 18.0 * mMoshHold
    );
    vec3 heldColor = texture(u_moshTex, clamp(v_uv - moshOffset, 0.0, 1.0)).rgb;
    float keyMask = smoothstep(0.15, 0.65, abs(srcLuma - dot(heldColor, vec3(0.333))));
    srcColor = mix(heldColor, srcColor, mix(1.0, keyMask * 0.35, mMoshHold));
  }

  // --- COLUMN 3A & 3B: Dirty Video Mixer Ping-Pong Feedback Loop ---
  if (mFbackMix > 0.005) {
    float dtScale = clamp(u_dt * 60.0, 0.25, 2.5);
    vec2 center = vec2(0.5);
    vec2 d = v_uv - center;

    // Feedback Warp controls zoom + spin + wave ripple inside feedback loop (normalized to 60 FPS)
    float zoom = 1.0 - ((mFbackWarp - 0.25) * 0.065 + u_fft.y * 0.015 * mFbackMix) * dtScale;
    float angle = (mFbackWarp - 0.25) * 0.08 * sin(u_time * 0.8) * dtScale;
    float ca = cos(angle);
    float sa = sin(angle);
    vec2 warpedUv = center + mat2(ca, -sa, sa, ca) * (d * zoom);

    vec3 fbColor = texture(u_feedbackTex, clamp(warpedUv, 0.002, 0.998)).rgb;

    // Hue drift inside feedback loop
    vec3 fbYiq = rgb2yiq(fbColor);
    float hueDrift = (0.06 + mFbackWarp * 0.22) * dtScale;
    float ch = cos(hueDrift);
    float sh = sin(hueDrift);
    fbYiq.yz = mat2(ch, -sh, sh, ch) * fbYiq.yz;
    float decay = pow(0.985, dtScale);
    fbColor = clamp(yiq2rgb(fbYiq) * decay, 0.0, 1.0);

    // Dirty mixer luma-key / cross-modulation blend
    float srcLuma = dot(srcColor, vec3(0.299, 0.587, 0.114));
    vec3 dirtyBlend = mix(srcColor, abs(srcColor - fbColor * 0.85) + fbColor * 0.55, mFbackMix);
    float lumaKey = smoothstep(0.08, 0.85, srcLuma);
    vec3 trailBlend = mix(fbColor * pow(0.96, dtScale), srcColor, mix(1.0, lumaKey, mFbackMix * 0.78));

    srcColor = clamp(mix(trailBlend, dirtyBlend, mFbackWarp * 0.65), 0.0, 1.0);
  }

  outColor = vec4(srcColor, 1.0);
}
`;

// Pass 2: CRT Display Output Shader (Optional CRT Scanlines & Phosphor Grille)
const DISPLAY_FRAGMENT_SHADER_SRC = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_renderedTex;
uniform vec2 u_resolution;
uniform bool u_crtEmulation;

void main() {
  vec2 uv = v_uv;
  vec3 col = texture(u_renderedTex, uv).rgb;

  if (u_crtEmulation) {
    // Subtle scanline beam modulation & shadow mask
    float scanline = 0.92 + 0.08 * sin(uv.y * u_resolution.y * 3.14159265);
    float grille = 0.96 + 0.04 * sin(uv.x * u_resolution.x * 3.14159265);
    col *= scanline * grille;

    // Subtle CRT edge vignette
    vec2 vigUv = uv * (1.0 - uv.yx);
    float vig = clamp(pow(vigUv.x * vigUv.y * 16.0, 0.16), 0.0, 1.0);
    col *= vig;
  }

  outColor = vec4(col, 1.0);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`WebGL2 shader compile error: ${info}`);
  }
  return shader;
}

function createProgram(gl, vsSrc, fsSrc) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(prog);
    throw new Error(`WebGL2 program link error: ${info}`);
  }
  return prog;
}

function createFboTexturePair(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  return { tex, fbo, width, height };
}

export class WebGLVideoBender {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.onClipMetadataLoaded = options.onClipMetadataLoaded || null;
    this.gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: false
    });

    if (!this.gl) {
      throw new Error('WebGL2 is required for the Bent shader pipeline.');
    }

    this.width = 1280;
    this.height = 720;
    this.internalWidth = 960;
    this.internalHeight = 540;
    this._contextLost = false;

    // Offscreen 2D canvas used to render procedural sources & frame-fitted HTML5 <video> clips
    this.sourceCanvas = document.createElement('canvas');
    this.sourceCanvas.width = this.internalWidth;
    this.sourceCanvas.height = this.internalHeight;
    this.sourceCtx = this.sourceCanvas.getContext('2d', { alpha: false });

    this.videoElements = new Map(); // clip.id -> HTMLVideoElement
    this._activeVideoClipId = null;
    this.columnKill = [0, 0, 0, 0];
    this.moshFrozen = false;

    // Pre-allocated uniform upload buffers to avoid per-frame GC churn
    this._macrosBuf = new Float32Array(8);
    this._columnKillBuf = new Float32Array(4);
    this._sourceTexInitialized = false;

    this._initGl();
    this._bindContextEvents();
  }

  _bindContextEvents() {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this._contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this._contextLost = false;
      this.fboA = null;
      this.fboB = null;
      this.moshFbo = null;
      this._sourceTexInitialized = false;
      this._initGl();
      this.clearFeedbackBuffers();
    });
  }

  _initGl() {
    const gl = this.gl;
    this.bendProgram = createProgram(gl, VERTEX_SHADER_SRC, BEND_FRAGMENT_SHADER_SRC);
    this.displayProgram = createProgram(gl, VERTEX_SHADER_SRC, DISPLAY_FRAGMENT_SHADER_SRC);

    // Cache uniform locations once instead of querying every frame
    this._bendLocs = {
      sourceTex: gl.getUniformLocation(this.bendProgram, 'u_sourceTex'),
      feedbackTex: gl.getUniformLocation(this.bendProgram, 'u_feedbackTex'),
      moshTex: gl.getUniformLocation(this.bendProgram, 'u_moshTex'),
      resolution: gl.getUniformLocation(this.bendProgram, 'u_resolution'),
      time: gl.getUniformLocation(this.bendProgram, 'u_time'),
      dt: gl.getUniformLocation(this.bendProgram, 'u_dt'),
      macros: gl.getUniformLocation(this.bendProgram, 'u_macros[0]'),
      fft: gl.getUniformLocation(this.bendProgram, 'u_fft'),
      columnKill: gl.getUniformLocation(this.bendProgram, 'u_columnKill[0]')
    };
    this._displayLocs = {
      renderedTex: gl.getUniformLocation(this.displayProgram, 'u_renderedTex'),
      resolution: gl.getUniformLocation(this.displayProgram, 'u_resolution'),
      crtEmulation: gl.getUniformLocation(this.displayProgram, 'u_crtEmulation')
    };

    // Fullscreen quad VAO
    const quadVerts = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Source texture uploaded from this.sourceCanvas
    this.sourceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      this.internalWidth, this.internalHeight, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null
    );
    this._sourceTexInitialized = true;

    this._allocateFbos(this.internalWidth, this.internalHeight);
  }

  _allocateFbos(w, h) {
    const gl = this.gl;
    if (this.fboA) {
      gl.deleteFramebuffer(this.fboA.fbo);
      gl.deleteTexture(this.fboA.tex);
      gl.deleteFramebuffer(this.fboB.fbo);
      gl.deleteTexture(this.fboB.tex);
      gl.deleteFramebuffer(this.moshFbo.fbo);
      gl.deleteTexture(this.moshFbo.tex);
    }
    this.fboA = createFboTexturePair(gl, w, h);
    this.fboB = createFboTexturePair(gl, w, h);
    this.moshFbo = createFboTexturePair(gl, w, h);
    this.moshFrozen = false;
  }

  setCanvasResolution(width, height) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    // Keep source generator resolution proportional and fast
    const scale = width > 1280 ? 0.5 : 0.75;
    const nextW = Math.max(320, Math.round(width * scale));
    const nextH = Math.max(240, Math.round(height * scale));
    if (nextW !== this.internalWidth || nextH !== this.internalHeight) {
      this.internalWidth = nextW;
      this.internalHeight = nextH;
      this.sourceCanvas.width = this.internalWidth;
      this.sourceCanvas.height = this.internalHeight;
      this._sourceTexInitialized = false;
      if (!this._contextLost) {
        this._allocateFbos(this.internalWidth, this.internalHeight);
      }
    }
  }

  clearFeedbackBuffers() {
    if (this._contextLost) return;
    const gl = this.gl;
    for (const target of [this.fboA, this.fboB, this.moshFbo]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.moshFrozen = false;
  }

  /**
   * Release all cached <video> elements (e.g. when loading a new project).
   */
  disposeVideoElements() {
    for (const vid of this.videoElements.values()) {
      try {
        vid.pause();
        vid.removeAttribute('src');
        vid.load();
      } catch (_e) {
        // Ignore teardown errors
      }
    }
    this.videoElements.clear();
    this._activeVideoClipId = null;
  }

  _pauseInactiveVideos(activeClipId) {
    if (this._activeVideoClipId === activeClipId) return;
    for (const [id, vid] of this.videoElements.entries()) {
      if (id !== activeClipId && !vid.paused) {
        vid.pause();
      }
    }
    this._activeVideoClipId = activeClipId;
  }

  /**
   * Ensure an HTML5 <video> element exists and is loaded for an imported local file clip.
   */
  ensureVideoElement(clip) {
    if (!clip || clip.sourceType !== 'file') return null;
    let vid = this.videoElements.get(clip.id);
    const url = clip.mediaUrl || (window.bentDesktop && clip.filePath ? window.bentDesktop.toMediaUrl(clip.filePath) : clip.filePath);
    if (!vid) {
      vid = document.createElement('video');
      vid.muted = true;
      vid.loop = true;
      vid.playsInline = true;
      vid.crossOrigin = 'anonymous';
      vid.preload = 'auto';
      if (url) {
        vid.src = url;
        vid.setAttribute('data-src', url);
      }
      vid.addEventListener('loadedmetadata', () => {
        if (vid.duration && Number.isFinite(vid.duration)) {
          const prevDur = clip.duration;
          const realDur = Number(vid.duration.toFixed(2));
          clip.duration = realDur;
          // Expand outPoint when replacing the initial placeholder duration, or clamp if outPoint exceeds real duration
          if (!clip.outPoint || clip.outPoint >= prevDur - 0.05 || clip.outPoint > realDur) {
            clip.outPoint = realDur;
          }
          if (clip.inPoint >= clip.outPoint) {
            clip.inPoint = 0;
          }
          this.onClipMetadataLoaded?.(clip);
        }
      });
      this.videoElements.set(clip.id, vid);
    } else if (url && vid.getAttribute('data-src') !== url) {
      vid.src = url;
      vid.setAttribute('data-src', url);
    }
    return vid;
  }

  /**
   * Render one frame of the active clip + 8 Global Circuit-Bend Macros + Audio FFT modulation.
   */
  renderFrame({
    clip,
    clipTime = 0,
    globalTime = 0,
    dt = 1 / 60,
    macros = [0, 0, 0.25, 0, 0, 0, 0, 0],
    fft = { sub: 0, kick: 0, mid: 0, high: 0 },
    aspectFit = 'cover',
    crtEmulation = true,
    isScrubbing = false,
    playbackSpeed = 1.0,
    isReversed = false
  }) {
    if (this._contextLost) return;

    // 1. Draw the current video frame (procedural or local file) onto this.sourceCanvas
    this._drawSourceFrame(clip, clipTime, fft, aspectFit, isScrubbing, playbackSpeed, isReversed);

    // 2. Upload this.sourceCanvas to this.sourceTex
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    if (this._sourceTexInitialized) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.sourceCanvas);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.sourceCanvas);
      this._sourceTexInitialized = true;
    }

    // 3. Execute Pass 1 (Circuit-Bend Shader) into fboA reading fboB as feedback
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fboA.fbo);
    gl.viewport(0, 0, this.internalWidth, this.internalHeight);
    gl.useProgram(this.bendProgram);

    const locs = this._bendLocs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTex);
    gl.uniform1i(locs.sourceTex, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fboB.tex);
    gl.uniform1i(locs.feedbackTex, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.moshFbo.tex);
    gl.uniform1i(locs.moshTex, 2);

    gl.uniform2f(locs.resolution, this.internalWidth, this.internalHeight);
    gl.uniform1f(locs.time, globalTime);
    gl.uniform1f(locs.dt, dt);

    for (let i = 0; i < 8; i++) this._macrosBuf[i] = macros[i] || 0;
    gl.uniform1fv(locs.macros, this._macrosBuf);

    gl.uniform4f(
      locs.fft,
      fft.sub || 0,
      fft.kick || 0,
      fft.mid || 0,
      fft.high || 0
    );

    for (let i = 0; i < 4; i++) this._columnKillBuf[i] = this.columnKill[i] || 0;
    gl.uniform1fv(locs.columnKill, this._columnKillBuf);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // 4. Update Datamosh Reference FBO whenever effective Fader 4 (datamoshHold) is low (< 0.12)
    // so raising Fader 4 freezes the last clean frame and smears motion across it!
    const effectiveMosh = (macros[7] || 0) * (1.0 - (this.columnKill[3] || 0));
    if (effectiveMosh < 0.12 || !this.moshFrozen) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fboA.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.moshFbo.fbo);
      gl.blitFramebuffer(
        0, 0, this.internalWidth, this.internalHeight,
        0, 0, this.internalWidth, this.internalHeight,
        gl.COLOR_BUFFER_BIT, gl.NEAREST
      );
      this.moshFrozen = effectiveMosh >= 0.12;
    }

    // 5. Execute Pass 2 (CRT Display Post-Process) to main screen canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.displayProgram);

    const dLocs = this._displayLocs;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fboA.tex);
    gl.uniform1i(dLocs.renderedTex, 0);
    gl.uniform2f(dLocs.resolution, this.width, this.height);
    gl.uniform1i(dLocs.crtEmulation, crtEmulation ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);

    // 6. Swap Ping-Pong FBOs (fboA <-> fboB)
    const temp = this.fboA;
    this.fboA = this.fboB;
    this.fboB = temp;
  }

  _drawSourceFrame(clip, clipTime, fft, aspectFit, isScrubbing, playbackSpeed = 1.0, isReversed = false) {
    const ctx = this.sourceCtx;
    const w = this.internalWidth;
    const h = this.internalHeight;

    ctx.save();
    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);

    if (!clip) {
      this._pauseInactiveVideos(null);
      this._drawProceduralPM5544(ctx, w, h, clipTime, fft);
      ctx.restore();
      return;
    }

    // Apply clip transforms (cropZoom, flipH, flipV)
    const zoom = Math.max(0.25, Math.min(4.0, Number(clip.cropZoom) || 1.0));
    const sx = (clip.flipH ? -1 : 1) * zoom;
    const sy = (clip.flipV ? -1 : 1) * zoom;
    if (sx !== 1 || sy !== 1) {
      ctx.translate(w / 2, h / 2);
      ctx.scale(sx, sy);
      ctx.translate(-w / 2, -h / 2);
    }

    if (clip.sourceType === 'file') {
      this._pauseInactiveVideos(clip.id);
      const vid = this.ensureVideoElement(clip);
      if (vid && vid.readyState >= 2) {
        const shouldSeekMode = isScrubbing || isReversed;
        const safeRate = Math.max(0.25, Math.min(4.0, Number(playbackSpeed) || 1.0));
        if (!shouldSeekMode && Math.abs(vid.playbackRate - safeRate) > 0.02) {
          vid.playbackRate = safeRate;
        }
        const seekThreshold = shouldSeekMode ? 0.035 : 0.25;
        if (Math.abs(vid.currentTime - clipTime) > seekThreshold && !vid.seeking) {
          try {
            vid.currentTime = clipTime;
          } catch (_e) {
            // Ignore seek race
          }
        }
        if (vid.paused && !shouldSeekMode) {
          vid.play().catch(() => {});
        } else if (!vid.paused && shouldSeekMode) {
          vid.pause();
        }
        this._drawMediaWithAspectFit(ctx, vid, vid.videoWidth || w, vid.videoHeight || h, w, h, aspectFit);
        ctx.restore();
        return;
      }
    } else {
      this._pauseInactiveVideos(null);
    }

    // Procedural Analog Video Synth Sources (deterministic at clipTime!)
    const gen = clip.generatorId || 'pm5544';
    if (gen === 'oscilloscope') {
      this._drawProceduralOscilloscope(ctx, w, h, clipTime, fft);
    } else if (gen === 'cybergrid') {
      this._drawProceduralCybergrid(ctx, w, h, clipTime, fft);
    } else if (gen === 'contours') {
      this._drawProceduralContours(ctx, w, h, clipTime, fft);
    } else if (gen === 'datastream') {
      this._drawProceduralDatastream(ctx, w, h, clipTime, fft);
    } else if (gen === 'moire') {
      this._drawProceduralMoire(ctx, w, h, clipTime, fft);
    } else {
      this._drawProceduralPM5544(ctx, w, h, clipTime, fft);
    }

    ctx.restore();
  }

  _drawMediaWithAspectFit(ctx, media, srcW, srcH, dstW, dstH, fit = 'cover') {
    if (fit === 'stretch' || !srcW || !srcH) {
      ctx.drawImage(media, 0, 0, dstW, dstH);
      return;
    }
    const srcRatio = srcW / srcH;
    const dstRatio = dstW / dstH;
    let drawW = dstW;
    let drawH = dstH;

    if (fit === 'contain') {
      if (srcRatio > dstRatio) {
        drawH = dstW / srcRatio;
      } else {
        drawW = dstH * srcRatio;
      }
    } else {
      // cover
      if (srcRatio > dstRatio) {
        drawW = dstH * srcRatio;
      } else {
        drawH = dstW / srcRatio;
      }
    }
    const ox = (dstW - drawW) * 0.5;
    const oy = (dstH - drawH) * 0.5;
    ctx.drawImage(media, ox, oy, drawW, drawH);
  }

  // --- 1. Philips PM5544 / NTSC Broadcast Test Card ---
  _drawProceduralPM5544(ctx, w, h, t, fft) {
    // Background checkerboard grid
    const cols = 16;
    const rows = 12;
    const cw = w / cols;
    const ch = h / rows;

    ctx.fillStyle = '#181a24';
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = '#d8e2ee';
    ctx.lineWidth = 2;
    for (let i = 0; i <= cols; i++) {
      ctx.beginPath();
      ctx.moveTo(i * cw, 0);
      ctx.lineTo(i * cw, h);
      ctx.stroke();
    }
    for (let j = 0; j <= rows; j++) {
      ctx.beginPath();
      ctx.moveTo(0, j * ch);
      ctx.lineTo(w, j * ch);
      ctx.stroke();
    }

    // Center broadcast circle
    const cx = w * 0.5;
    const cy = h * 0.5;
    const radius = Math.min(w, h) * 0.39 * (1 + (fft.kick || 0) * 0.08);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.clip();

    // SMPTE / EBU Color Bars inside circle
    const colors = ['#ffffff', '#ffe600', '#00f5d4', '#00e050', '#ff00c8', '#ff2038', '#1445ff', '#090a0f'];
    const barY = cy - radius * 0.45;
    const barH = radius * 0.9;
    const barW = (radius * 2) / colors.length;
    for (let i = 0; i < colors.length; i++) {
      ctx.fillStyle = colors[i];
      ctx.fillRect(cx - radius + i * barW, barY, barW + 1, barH);
    }

    // Top & bottom contrast gratings
    ctx.fillStyle = '#0b0c12';
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 0.55);
    ctx.fillRect(cx - radius, cy + radius * 0.45, radius * 2, radius * 0.55);

    // Scrolling frequency burst bars
    const steps = 18;
    for (let i = 0; i < steps; i++) {
      const phase = ((i + t * 4) % steps) / steps;
      ctx.fillStyle = i % 2 === 0 ? '#f4f7fb' : '#10131a';
      ctx.fillRect(cx - radius + phase * radius * 2, cy + radius * 0.12, (radius * 2) / steps, radius * 0.32);
    }

    ctx.restore();

    // Outer white & cyan registration ring
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Center crosshair + rotating radar sweep arm
    const angle = t * 1.8;
    ctx.strokeStyle = '#00f5d4';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.stroke();

    // Timecode box
    ctx.fillStyle = '#07080d';
    ctx.fillRect(cx - 110, cy - radius * 0.78, 220, 34);
    ctx.strokeStyle = '#00f5d4';
    ctx.strokeRect(cx - 110, cy - radius * 0.78, 220, 34);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 18px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`BENT // TC ${t.toFixed(2)}s`, cx, cy - radius * 0.78 + 23);
  }

  // --- 2. Lissajous Vector Oscilloscope ---
  _drawProceduralOscilloscope(ctx, w, h, t, fft) {
    ctx.fillStyle = '#04080e';
    ctx.fillRect(0, 0, w, h);

    // Subtle CRT graticule
    ctx.strokeStyle = 'rgba(0, 245, 212, 0.14)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      ctx.beginPath();
      ctx.moveTo((w / 10) * i, 0);
      ctx.lineTo((w / 10) * i, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, (h / 10) * i);
      ctx.lineTo(w, (h / 10) * i);
      ctx.stroke();
    }

    const cx = w * 0.5;
    const cy = h * 0.5;
    const scale = Math.min(w, h) * (0.36 + (fft.kick || 0) * 0.12);

    const layers = [
      { color: '#00f5d4', freqX: 3, freqY: 2, phase: t * 2.2, width: 4 },
      { color: '#ff3864', freqX: 5, freqY: 4, phase: -t * 1.6, width: 3 },
      { color: '#fee440', freqX: 7, freqY: 6, phase: t * 3.1, width: 2 }
    ];

    for (const layer of layers) {
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width;
      ctx.beginPath();
      const samples = 220;
      for (let i = 0; i <= samples; i++) {
        const a = (i / samples) * Math.PI * 2;
        const mod = 1 + 0.22 * Math.sin(a * 4 + t * 5);
        const x = cx + Math.sin(a * layer.freqX + layer.phase) * scale * mod;
        const y = cy + Math.cos(a * layer.freqY + t * 1.3) * scale * mod;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }

  // --- 3. 1984 Synthwave Vector Horizon & Wireframe Polyhedra ---
  _drawProceduralCybergrid(ctx, w, h, t, fft) {
    const horizonY = h * 0.48;

    // Sky gradient
    const sky = ctx.createLinearGradient(0, 0, 0, horizonY);
    sky.addColorStop(0, '#090418');
    sky.addColorStop(1, '#2d0b4e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, horizonY);

    // Segmented Retro Sun
    const sunR = Math.min(w, h) * (0.22 + (fft.sub || 0) * 0.05);
    const sunGrad = ctx.createLinearGradient(0, horizonY - sunR * 1.8, 0, horizonY);
    sunGrad.addColorStop(0, '#fee440');
    sunGrad.addColorStop(0.5, '#ff6b35');
    sunGrad.addColorStop(1, '#ff007f');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(w * 0.5, horizonY - sunR * 0.35, sunR, 0, Math.PI * 2);
    ctx.fill();

    // Scanline cutouts across the sun
    ctx.fillStyle = '#24083d';
    for (let i = 0; i < 7; i++) {
      const y = horizonY - sunR * 0.9 + i * (sunR * 0.14);
      ctx.fillRect(w * 0.5 - sunR * 1.1, y, sunR * 2.2, 3 + i * 1.6);
    }

    // Ground plane
    ctx.fillStyle = '#070312';
    ctx.fillRect(0, horizonY, w, h - horizonY);

    // Perspective Grid
    ctx.strokeStyle = '#00f5d4';
    ctx.lineWidth = 2;
    const numRays = 20;
    for (let i = -numRays; i <= numRays; i++) {
      ctx.beginPath();
      ctx.moveTo(w * 0.5 + i * (w * 0.015), horizonY);
      ctx.lineTo(w * 0.5 + i * (w * 0.14), h);
      ctx.stroke();
    }

    const scroll = (t * 2.2) % 1;
    for (let j = 1; j <= 12; j++) {
      const p = Math.pow((j + scroll) / 12, 2.1);
      const y = horizonY + p * (h - horizonY);
      ctx.strokeStyle = j % 2 === 0 ? '#ff2a6d' : '#00f5d4';
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Spinning wireframe octahedron in the sky
    const cx = w * 0.5;
    const cy = horizonY * 0.55;
    const r = Math.min(w, h) * 0.16;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    for (let k = 0; k < 4; k++) {
      const a1 = t * 1.5 + (k * Math.PI) / 2;
      const a2 = t * 1.5 + ((k + 1) * Math.PI) / 2;
      const x1 = cx + Math.cos(a1) * r;
      const y1 = cy + Math.sin(a1) * r * 0.38;
      const x2 = cx + Math.cos(a2) * r;
      const y2 = cy + Math.sin(a2) * r * 0.38;

      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(x1, y1);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(x2, y2);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }

  // --- 4. Topographic Luma Plasma (Ideal for Wavefolding) ---
  _drawProceduralContours(ctx, w, h, t, fft) {
    ctx.fillStyle = '#080610';
    ctx.fillRect(0, 0, w, h);

    const bands = 14;
    const palette = ['#ff2a6d', '#ffbe0b', '#00f5d4', '#7209b7', '#ffffff'];
    for (let b = bands; b >= 1; b--) {
      const frac = b / bands;
      const cx = w * 0.5 + Math.sin(t * 1.4 + b * 0.5) * w * 0.18;
      const cy = h * 0.5 + Math.cos(t * 1.1 + b * 0.4) * h * 0.16;
      const radius = Math.max(w, h) * 0.58 * frac * (1 + (fft.kick || 0) * 0.08);

      ctx.fillStyle = palette[b % palette.length];
      ctx.beginPath();
      const pts = 48;
      for (let i = 0; i <= pts; i++) {
        const ang = (i / pts) * Math.PI * 2;
        const wobble =
          1 +
          0.16 * Math.sin(ang * 3 + t * 2.5 + b) +
          0.1 * Math.cos(ang * 5 - t * 1.8);
        const px = cx + Math.cos(ang) * radius * wobble;
        const py = cy + Math.sin(ang) * radius * wobble;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // --- 5. Telemetry Radar & Scanline Matrix ---
  _drawProceduralDatastream(ctx, w, h, t, fft) {
    ctx.fillStyle = '#050806';
    ctx.fillRect(0, 0, w, h);

    // High-contrast barcode strips on left and right
    const strips = 28;
    const stripH = h / strips;
    for (let i = 0; i < strips; i++) {
      const active = Math.sin(i * 1.7 + t * 9) > 0;
      ctx.fillStyle = active ? '#38b000' : '#112211';
      ctx.fillRect(24, i * stripH + 2, w * 0.16, stripH - 4);

      const activeR = Math.cos(i * 2.3 - t * 11) > 0;
      ctx.fillStyle = activeR ? '#00f5d4' : '#0a1e22';
      ctx.fillRect(w - 24 - w * 0.16, i * stripH + 2, w * 0.16, stripH - 4);
    }

    // Central Radar Target
    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.min(w, h) * 0.36;

    for (let r = 1; r <= 4; r++) {
      ctx.strokeStyle = r === 4 ? '#ffffff' : '#38b000';
      ctx.lineWidth = r === 4 ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, (maxR / 4) * r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Rotating sweep wedge
    const sweep = t * 3.2;
    ctx.fillStyle = 'rgba(56, 176, 0, 0.38)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, maxR, sweep, sweep + 0.75);
    ctx.closePath();
    ctx.fill();

    // Pulse waveform bar across middle
    ctx.strokeStyle = '#ffbe0b';
    ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 12) {
      const norm = x / w;
      const y =
        cy +
        Math.sin(norm * 24 + t * 14) *
          Math.cos(norm * 9 - t * 7) *
          (45 + (fft.kick || 0) * 90);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // --- 6. Zone Plate Moiré Interference Rings ---
  _drawProceduralMoire(ctx, w, h, t, fft) {
    ctx.fillStyle = '#07070c';
    ctx.fillRect(0, 0, w, h);

    const centers = [
      {
        x: w * 0.5 + Math.cos(t * 1.3) * w * 0.14,
        y: h * 0.5 + Math.sin(t * 1.1) * h * 0.12,
        color: '#ffffff'
      },
      {
        x: w * 0.5 - Math.cos(t * 1.6) * w * 0.14,
        y: h * 0.5 - Math.sin(t * 0.9) * h * 0.12,
        color: '#00f5d4'
      },
      {
        x: w * 0.5 + Math.sin(t * 1.9) * w * 0.1,
        y: h * 0.5 - Math.cos(t * 1.4) * h * 0.1,
        color: '#ff2a6d'
      }
    ];

    const maxR = Math.max(w, h) * 0.52;
    const rings = 22;
    for (const c of centers) {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 5 + (fft.sub || 0) * 4;
      for (let r = 1; r <= rings; r++) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, (maxR / rings) * r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}
