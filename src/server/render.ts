import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as config from './config.ts';
import {
  DEFAULT_FACECAM,
  type FacecamRect,
  facecamToOverlayPx,
  isFacecamRect,
  normalizeSplitRatio,
  splitHeightsPx,
} from './facecam.ts';
import type { WordStamp } from './hashtags.ts';
import {
  buildTrackCropXExpr,
  sourceBoxToCropPx,
  type SourceFacecamBox,
  type TrackPoint,
} from './vision.ts';

const execFileAsync = promisify(execFile);

export const W = config.OUT_W;
export const H = config.OUT_H;

export interface StyleDef {
  label: string;
  font: string;
  size: number;
  base: string;
  active: string;
  strong: string;
  outline: number;
  pop: number;
  upper: boolean;
  per: number;
}

export const STYLES: Record<string, StyleDef> = {
  bounce: {
    label: 'Bounce',
    font: 'Poppins ExtraBold',
    size: 132,
    base: 'FFFFFF',
    active: '00F0FF',
    strong: 'FFFFFF',
    outline: 7,
    pop: 112,
    upper: true,
    per: 3,
  },
  hype: {
    label: 'Hype',
    font: 'Anton',
    size: 152,
    base: 'FFFFFF',
    active: '3C3CFF',
    strong: '00D7FF',
    outline: 7,
    pop: 114,
    upper: true,
    per: 2,
  },
  clean: {
    label: 'Clean',
    font: 'Poppins ExtraBold',
    size: 100,
    base: 'FFFFFF',
    active: '6BD7FF',
    strong: 'FFFFFF',
    outline: 5,
    pop: 106,
    upper: false,
    per: 4,
  },
};

export const HOOK = {
  font: 'Poppins ExtraBold',
  size: 96,
  ink: '14100E',
  box: 'FFFFFF',
  pad_x: 36,
  pad_y: 22,
  radius: 26,
  max_w: 900,
};

export const LAYOUTS: Record<string, string> = {
  smart: 'Smart auto (facecam + person tracking)',
  track: 'Auto person tracking (follows speaker)',
  split_gameplay: 'Splitscreen: gameplay + facecam',
  gameplay: 'Gameplay + movable facecam',
  split: 'Split screen: left half on top, right half below (two people)',
  crop: 'Fill the screen (centre crop)',
  left: 'Fill the screen, keep the left side',
  right: 'Fill the screen, keep the right side',
  blur: 'Full frame + blurred fill',
  zoom: 'Zoomed in + blurred fill',
  fit: 'Full frame on black',
};

const FILLS = new Set(['smart', 'track', 'crop', 'left', 'right', 'gameplay']);
const CAP_MAX_W = 960;
const PIP_W = 380;
const PIP_MARGIN = 26;

function formatAssTs(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = clamped % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function cleanAssText(text: string): string {
  return String(text || '')
    .replace(/[{}\\]/g, '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim();
}

function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '');
}

function estimateTextWidth(text: string, size: number, font: string): number {
  const factor = font === 'Anton' ? 0.44 : 0.56;
  return text.length * size * factor;
}

export function groupWords(words: WordStamp[], per: number): WordStamp[][] {
  const out: WordStamp[][] = [];
  let cur: WordStamp[] = [];
  for (const w of words) {
    const curChars = cur.reduce((acc, x) => acc + x.w.length, 0);
    if (
      cur.length > 0 &&
      (cur.length >= per ||
        curChars + w.w.length > 16 ||
        w.s - cur[cur.length - 1].e > 0.45 ||
        /[.?!]$/.test(cur[cur.length - 1].w))
    ) {
      out.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export interface ClipGeometry {
  layout: string;
  fgH: number;
  hookY: number;
  capY: number;
}

export function geometry(srcW: number, srcH: number, requestedLayout: string, splitRatio?: number | null): ClipGeometry {
  let layout = requestedLayout;
  if (srcH >= srcW && layout !== 'crop') {
    layout = 'crop';
  }
  if (!(layout in LAYOUTS)) {
    layout = 'track';
  }
  let fgH: number;
  if (layout === 'blur' || layout === 'fit') {
    fgH = Math.min(H, Math.round((W * srcH) / Math.max(1, srcW) / 2) * 2);
  } else if (layout === 'zoom') {
    fgH = 1000;
  } else {
    fgH = H;
  }
  const top = Math.floor((H - fgH) / 2);
  if (FILLS.has(layout)) {
    return { layout, fgH, hookY: 300, capY: 1380 };
  }
  if (layout === 'split_gameplay') {
    const { topH } = splitHeightsPx(normalizeSplitRatio(splitRatio), H);
    const capY = Math.max(520, Math.min(1280, topH));
    return { layout, fgH, hookY: 210, capY };
  }
  if (layout === 'split') {
    return { layout, fgH, hookY: 230, capY: Math.floor(H / 2) };
  }
  return {
    layout,
    fgH,
    hookY: Math.max(230, top - 190),
    capY: Math.min(1640, top + fgH + 180),
  };
}

function hookEvents(hook: string, dur: number, y: number): string[] {
  const words = cleanAssText(hook).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  let size = HOOK.size;
  let lines = [words.join(' ')];
  if (estimateTextWidth(lines[0], size, HOOK.font) > HOOK.max_w && words.length > 1) {
    let bestCut = 1;
    let bestMax = Infinity;
    for (let i = 1; i < words.length; i++) {
      const w1 = estimateTextWidth(words.slice(0, i).join(' '), size, HOOK.font);
      const w2 = estimateTextWidth(words.slice(i).join(' '), size, HOOK.font);
      const m = Math.max(w1, w2);
      if (m < bestMax) {
        bestMax = m;
        bestCut = i;
      }
    }
    lines = [words.slice(0, bestCut).join(' '), words.slice(bestCut).join(' ')];
  }
  let widest = Math.max(...lines.map((l) => estimateTextWidth(l, size, HOOK.font)));
  if (widest > HOOK.max_w) {
    size = Math.max(40, Math.floor((size * HOOK.max_w) / widest));
    widest = Math.max(...lines.map((l) => estimateTextWidth(l, size, HOOK.font)));
  }
  const lineH = size * 0.96;
  const bw = widest + 2 * HOOK.pad_x;
  const bh = lineH * lines.length + 2 * HOOK.pad_y;
  const x0 = (W - bw) / 2;
  const y0 = y - bh / 2;
  const r = Math.min(HOOK.radius, bh / 2);
  const x1 = x0 + bw;
  const y1 = y0 + bh;
  const n = (v: number) => Math.round(v).toString();
  const box =
    `m ${n(x0 + r)} ${n(y0)} l ${n(x1 - r)} ${n(y0)} b ${n(x1)} ${n(y0)} ${n(x1)} ${n(y0)} ${n(x1)} ${n(y0 + r)} ` +
    `l ${n(x1)} ${n(y1 - r)} b ${n(x1)} ${n(y1)} ${n(x1)} ${n(y1)} ${n(x1 - r)} ${n(y1)} ` +
    `l ${n(x0 + r)} ${n(y1)} b ${n(x0)} ${n(y1)} ${n(x0)} ${n(y1)} ${n(x0)} ${n(y1 - r)} ` +
    `l ${n(x0)} ${n(y0 + r)} b ${n(x0)} ${n(y0)} ${n(x0)} ${n(y0)} ${n(x0 + r)} ${n(y0)}`;
  const span = `${formatAssTs(0)},${formatAssTs(dur)}`;
  const ev = [
    `Dialogue: 3,${span},Hook,,0,0,0,,{\\an7\\pos(0,0)\\fad(160,0)\\c&H${HOOK.box}&\\p1}${box}{\\p0}`,
  ];
  for (let i = 0; i < lines.length; i++) {
    const cy = y - (lineH * (lines.length - 1)) / 2 + i * lineH;
    ev.push(
      `Dialogue: 4,${span},Hook,,0,0,0,,{\\an5\\pos(${Math.floor(W / 2)},${Math.round(cy)})\\fad(160,0)\\fs${size}}${lines[i]}`,
    );
  }
  return ev;
}

export function buildAss(
  words: WordStamp[],
  start: number,
  end: number,
  hook: string,
  styleName: string,
  highlight: string[],
  hookY: number,
  capY: number,
): string {
  const st = STYLES[styleName] ?? STYLES.bounce;
  const strong = new Set(highlight.map(wordKey).filter(Boolean));
  const dur = Math.max(0.5, end - start);

  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,${st.font},${st.size},&H00${st.base},&H00${st.base},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,${st.outline},0,5,0,0,0,1
Style: Hook,${HOOK.font},${HOOK.size},&H00${HOOK.ink},&H00${HOOK.ink},&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const ev: string[] = [];
  if (hook) {
    ev.push(...hookEvents(hook, dur, hookY));
  }

  const clipped = words.filter((w) => w.e > start && w.s < end);
  const groups = groupWords(clipped, st.per);

  for (const g of groups) {
    const texts = g.map((w) => {
      const cleaned = cleanAssText(w.w);
      return st.upper ? cleaned.toUpperCase() : cleaned;
    });
    const gStart = Math.max(0, g[0].s - start);
    const gEnd = Math.min(dur, g[g.length - 1].e - start + 0.12);
    if (gEnd - gStart < 0.04) continue;

    let size = st.size;
    let gap = size * 0.28 + (2 * st.outline + 6);
    let total = texts.reduce((acc, t) => acc + estimateTextWidth(t, size, st.font), 0) + gap * (texts.length - 1);
    if (total > CAP_MAX_W) {
      size = Math.max(36, Math.floor((size * CAP_MAX_W) / total));
      gap = size * 0.28 + (2 * st.outline + 6) * (size / st.size);
      total = texts.reduce((acc, t) => acc + estimateTextWidth(t, size, st.font), 0) + gap * (texts.length - 1);
    }

    let x = (W - total) / 2;
    for (let i = 0; i < g.length; i++) {
      const w = g[i];
      const t = texts[i];
      const wd = estimateTextWidth(t, size, st.font);
      const pop = Math.max(104, Math.min(st.pop, 100 + Math.floor(2200 / Math.max(wd, 1))));
      const pos = `\\an5\\pos(${Math.round(x + wd / 2)},${Math.round(capY)})\\fs${size}`;
      x += wd + gap;

      const a = Math.max(gStart, w.s - start);
      const b = i + 1 < g.length ? Math.min(gEnd, g[i + 1].s - start) : gEnd;
      const base = strong.has(wordKey(w.w)) ? st.strong : st.base;

      if (a - gStart >= 0.02) {
        ev.push(`Dialogue: 1,${formatAssTs(gStart)},${formatAssTs(a)},Cap,,0,0,0,,{${pos}\\c&H${base}&}${t}`);
      }
      if (b - a >= 0.02) {
        ev.push(
          `Dialogue: 2,${formatAssTs(a)},${formatAssTs(b)},Cap,,0,0,0,,{${pos}\\c&H${st.active}&\\fscx94\\fscy94\\t(0,90,\\fscx${pop}\\fscy${pop})\\t(90,200,\\fscx${pop - 5}\\fscy${pop - 5})}${t}`,
        );
      }
      if (gEnd - b >= 0.02) {
        ev.push(
          `Dialogue: 1,${formatAssTs(b)},${formatAssTs(gEnd)},Cap,,0,0,0,,{${pos}\\c&H${base}&\\fscx${pop - 5}\\fscy${pop - 5}\\t(0,90,\\fscx100\\fscy100)}${t}`,
        );
      }
    }
  }

  return head + ev.join('\n') + '\n';
}

export interface FilterGraphExtras {
  srcW?: number;
  srcH?: number;
  sourceFacecam?: SourceFacecamBox | null;
  trackPoints?: TrackPoint[] | null;
}

function buildSourceFacecamCrop(
  facecam: number[] | FacecamRect | null | undefined,
  sourceFacecam: SourceFacecamBox | null | undefined,
  srcW: number,
  srcH: number,
): string {
  if (sourceFacecam) {
    const px = sourceBoxToCropPx(sourceFacecam, srcW, srcH);
    return `crop=${px.w}:${px.h}:${px.x}:${px.y}`;
  }
  if (Array.isArray(facecam) && facecam.length === 4 && facecam[2] > 8 && facecam[3] > 8) {
    return `crop=${Math.round(facecam[2])}:${Math.round(facecam[3])}:${Math.round(facecam[0])}:${Math.round(facecam[1])}`;
  }
  return 'crop=iw*0.30:ih*0.34:iw*0.70:ih*0.66';
}

export function buildFilterGraph(
  layout: string,
  fgH: number,
  facecam?: number[] | FacecamRect | null,
  splitRatio?: number | null,
  extras?: FilterGraphExtras,
): string {
  const srcW = Math.max(16, extras?.srcW || 1280);
  const srcH = Math.max(16, extras?.srcH || 720);

  if (layout === 'split_gameplay') {
    const { topH, bottomH } = splitHeightsPx(normalizeSplitRatio(splitRatio), H);
    const fcCrop = buildSourceFacecamCrop(facecam, extras?.sourceFacecam, srcW, srcH);
    return (
      `[0:v]fps=${config.OUT_FPS},split=2[fc][gp];` +
      `[fc]${fcCrop},scale=${W}:${topH}:force_original_aspect_ratio=increase,crop=${W}:${topH}[t];` +
      `[gp]scale=${W}:${bottomH}:force_original_aspect_ratio=increase,crop=${W}:${bottomH}[b];` +
      `[t][b]vstack,setsar=1[v0];`
    );
  }
  if (layout === 'gameplay') {
    if (!extras?.sourceFacecam && Array.isArray(facecam) && facecam.length === 4) {
      const [fx, fy, fw, fh] = facecam.map((v) => Math.round(v));
      if (fw > 8 && fh > 8) {
        const pipH = Math.max(2, Math.round((PIP_W * fh) / fw));
        return (
          `[0:v]fps=${config.OUT_FPS},split=2[base][fc];` +
          `[base]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[b];` +
          `[fc]crop=${fw}:${fh}:${fx}:${fy},scale=${PIP_W}:${pipH},setsar=1[p];` +
          `[b][p]overlay=${W - PIP_W - PIP_MARGIN}:${PIP_MARGIN}[v0];`
        );
      }
    }
    const rect = isFacecamRect(facecam) ? facecam : DEFAULT_FACECAM;
    const ov = facecamToOverlayPx(rect, W, H);
    const fcCrop = buildSourceFacecamCrop(facecam, extras?.sourceFacecam, srcW, srcH);
    return (
      `[0:v]fps=${config.OUT_FPS},split=2[base][fc];` +
      `[base]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[b];` +
      `[fc]${fcCrop},scale=${ov.w}:${ov.h}:force_original_aspect_ratio=increase,crop=${ov.w}:${ov.h},setsar=1[p];` +
      `[b][p]overlay=${ov.x}:${ov.y}[v0];`
    );
  }
  if (layout === 'track' || layout === 'smart') {
    const xExpr = buildTrackCropXExpr(extras?.trackPoints, srcW, srcH, W, H);
    const quotedX = /[,()]/.test(xExpr) ? `'${xExpr}'` : xExpr;
    return `[0:v]fps=${config.OUT_FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:${quotedX}:0,setsar=1[v0];`;
  }
  const fill = `[0:v]fps=${config.OUT_FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  if (layout === 'crop') {
    return `${fill},setsar=1[v0];`;
  }
  if (layout === 'left') {
    return `${fill}:0:0,setsar=1[v0];`;
  }
  if (layout === 'right') {
    return `${fill}:in_w-out_w:0,setsar=1[v0];`;
  }
  if (layout === 'fit') {
    return `[0:v]fps=${config.OUT_FPS},scale=${W}:${fgH},pad=${W}:${H}:0:(oh-ih)/2:black,setsar=1[v0];`;
  }
  if (layout === 'split') {
    const half = `scale=${W}:${Math.floor(H / 2)}:force_original_aspect_ratio=increase,crop=${W}:${Math.floor(H / 2)}`;
    return (
      `[0:v]fps=${config.OUT_FPS},split=2[l][r];` +
      `[l]crop=iw/2:ih:0:0,${half}[t];` +
      `[r]crop=iw/2:ih:iw/2:0,${half}[u];` +
      `[t][u]vstack,setsar=1[v0];`
    );
  }
  return (
    `[0:v]fps=${config.OUT_FPS},split=2[a][b];` +
    `[a]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=6:2,scale=${W}:${H},eq=brightness=-0.14:saturation=1.15[bg];` +
    `[b]scale=${W}:${fgH}:force_original_aspect_ratio=increase,crop=${W}:${fgH}[fg];` +
    `[bg][fg]overlay=0:(H-h)/2,setsar=1[v0];`
  );
}

export async function renderClip(opts: {
  src: string;
  outDir: string;
  name: string;
  start: number;
  end: number;
  layout: string;
  style: string;
  hook: string;
  captions: boolean;
  highlightWords: string[];
  words: WordStamp[];
  srcW: number;
  srcH: number;
  hasAudio?: boolean;
  facecam?: number[] | FacecamRect | null;
  sourceFacecam?: SourceFacecamBox | null;
  trackPoints?: TrackPoint[] | null;
  splitRatio?: number | null;
  meta?: { title?: string; description?: string };
}): Promise<{ file: string; cover: string; layout: string }> {
  fs.mkdirSync(opts.outDir, { recursive: true });
  const srcW = opts.srcW || 1280;
  const srcH = opts.srcH || 720;
  const geom = geometry(srcW, srcH, opts.layout || 'track', opts.splitRatio);
  const layout = geom.layout;
  let hookY = geom.hookY;
  const hasLegacyFacecam = Array.isArray(opts.facecam) && opts.facecam.length === 4 && opts.facecam[2] > 8;
  if (layout === 'gameplay' && hasLegacyFacecam && Array.isArray(opts.facecam)) {
    hookY = PIP_MARGIN + Math.round((PIP_W * opts.facecam[3]) / opts.facecam[2]) + 32;
  } else if (layout === 'gameplay') {
    const ov = facecamToOverlayPx(isFacecamRect(opts.facecam) ? opts.facecam : DEFAULT_FACECAM, W, H);
    if (ov.y < 420) {
      hookY = Math.min(760, Math.max(300, ov.y + ov.h + 72));
    }
  }

  const ass = buildAss(
    opts.captions ? opts.words : [],
    opts.start,
    opts.end,
    opts.hook || '',
    opts.style || 'bounce',
    opts.highlightWords || [],
    hookY,
    geom.capY,
  );

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-'));
  try {
    const assFile = `${opts.name}.ass`;
    fs.writeFileSync(path.join(work, assFile), ass, 'utf-8');
    const fontsSub = path.join(work, 'f');
    fs.mkdirSync(fontsSub, { recursive: true });
    if (fs.existsSync(config.FONTS_DIR)) {
      for (const f of fs.readdirSync(config.FONTS_DIR)) {
        if (f.endsWith('.ttf')) {
          fs.copyFileSync(path.join(config.FONTS_DIR, f), path.join(fontsSub, f));
        }
      }
    }

    const dur = Math.max(1, opts.end - opts.start);
    const fg = buildFilterGraph(layout, geom.fgH, opts.facecam, opts.splitRatio, {
      srcW,
      srcH,
      sourceFacecam: opts.sourceFacecam,
      trackPoints: opts.trackPoints,
    });
    const fc = `${fg}[v0]ass=${assFile}:fontsdir=f[v]`;
    const args: string[] = [
      '-y',
      '-v',
      'error',
      '-ss',
      opts.start.toFixed(2),
      '-t',
      dur.toFixed(2),
      '-i',
      opts.src,
      '-filter_complex',
      fc,
      '-map',
      '[v]',
    ];

    if (opts.hasAudio !== false) {
      args.push('-map', '0:a:0?', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000');
    } else {
      args.push('-an');
    }

    if (opts.meta?.title) args.push('-metadata', `title=${opts.meta.title}`);
    if (opts.meta?.description) {
      args.push('-metadata', `description=${opts.meta.description}`);
      args.push('-metadata', `comment=${opts.meta.description}`);
    }

    args.push(
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-crf',
      '23',
      '-preset',
      'veryfast',
      `${opts.name}.mp4`,
    );

    await execFileAsync('ffmpeg', args, { cwd: work, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });

    const coverT = Math.min(1.2, dur / 2);
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-ss', coverT.toFixed(2), '-i', `${opts.name}.mp4`, '-frames:v', '1', '-q:v', '3', `${opts.name}.jpg`],
      { cwd: work, timeout: 30_000 },
    );

    for (const ext of ['mp4', 'jpg', 'ass']) {
      fs.copyFileSync(path.join(work, `${opts.name}.${ext}`), path.join(opts.outDir, `${opts.name}.${ext}`));
    }

    return { file: `${opts.name}.mp4`, cover: `${opts.name}.jpg`, layout };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
