import { GoogleGenAI, Type } from '@google/genai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentAiConfig, isAuthAiError, isTransientAiError } from './ai.ts';
import type { FacecamRect } from './facecam.ts';
import { extractSampleFrames } from './media.ts';
import { recordUsage } from './store.ts';

export type SourceFacecamBox = FacecamRect;

export interface TrackPoint {
  t: number; // seconds relative to clip start
  cx: number; // horizontal center 0..1 (0 = left edge, 0.5 = center, 1 = right edge)
  cy?: number; // vertical center 0..1
}

export type DetectedVideoType = 'gaming_facecam' | 'talking_head' | 'podcast_two_person' | 'general';

export interface VideoFramingAnalysis {
  videoType: DetectedVideoType;
  hasFacecam: boolean;
  sourceFacecam: SourceFacecamBox | null;
  primarySubjectX: number;
  recommendedLayout: 'split_gameplay' | 'gameplay' | 'track' | 'split';
  confidence: number;
  summary: string;
}

const VISION_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVisionClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Normalizes a detected facecam bounding box inside the source 16:9 video frame.
 * Accepts [0..1] fractions, [0..100] percentages, or [0..1000] Gemini normalized coords.
 * Rejects implausible boxes (too tiny or covering almost the whole frame).
 */
export function normalizeSourceBox(raw: unknown): SourceFacecamBox | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  let x = Number(r.x);
  let y = Number(r.y);
  let w = Number(r.w);
  let h = Number(r.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;

  const maxVal = Math.max(x, y, w, h);
  if (maxVal > 100) {
    x /= 1000;
    y /= 1000;
    w /= 1000;
    h /= 1000;
  } else if (maxVal > 1.01) {
    x /= 100;
    y /= 100;
    w /= 100;
    h /= 100;
  }

  // Must look like a webcam overlay box, not a pixel speck or full-screen frame
  if (w < 0.06 || h < 0.07 || w > 0.65 || h > 0.72) return null;

  x = clamp(x, 0, Math.max(0, 1 - w));
  y = clamp(y, 0, Math.max(0, 1 - h));
  w = clamp(w, 0.06, Math.min(0.65, 1 - x));
  h = clamp(h, 0.07, Math.min(0.72, 1 - y));

  return {
    x: round4(x),
    y: round4(y),
    w: round4(w),
    h: round4(h),
  };
}

/**
 * Converts a normalized source facecam box into even-aligned FFmpeg crop pixel coordinates.
 */
export function sourceBoxToCropPx(
  box: SourceFacecamBox,
  srcW: number,
  srcH: number,
): { x: number; y: number; w: number; h: number } {
  const safeW = Math.max(16, Math.round(srcW || 1280));
  const safeH = Math.max(16, Math.round(srcH || 720));
  const norm = normalizeSourceBox(box) ?? { x: 0.7, y: 0.66, w: 0.3, h: 0.34 };
  const w = clamp(even(norm.w * safeW), 32, even(safeW));
  const h = clamp(even(norm.h * safeH), 32, even(safeH));
  const x = clamp(even(norm.x * safeW), 0, Math.max(0, safeW - w));
  const y = clamp(even(norm.y * safeH), 0, Math.max(0, safeH - h));
  return { x, y, w, h };
}

/**
 * Smooths raw keyframe person-tracking points to eliminate frame-to-frame jitter
 * while keeping genuine camera pans responsive.
 */
export function smoothTrackPoints(rawPoints: TrackPoint[]): TrackPoint[] {
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) return [];
  const cleaned = rawPoints
    .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.cx))
    .map((p) => ({
      t: Math.max(0, Number(p.t.toFixed(2))),
      cx: clamp(Number(p.cx), 0.05, 0.95),
      cy: Number.isFinite(p.cy) ? clamp(Number(p.cy), 0.05, 0.95) : 0.42,
    }))
    .sort((a, b) => a.t - b.t);

  if (cleaned.length === 0) return [];

  // Deduplicate timestamps closer than 0.25s
  const deduped: TrackPoint[] = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (cleaned[i].t - prev.t < 0.25) {
      prev.cx = round4((prev.cx + cleaned[i].cx) / 2);
      prev.cy = round4(((prev.cy ?? 0.42) + (cleaned[i].cy ?? 0.42)) / 2);
    } else {
      deduped.push(cleaned[i]);
    }
  }

  if (deduped.length <= 2) {
    return deduped.map((p) => ({ t: p.t, cx: round4(p.cx), cy: round4(p.cy ?? 0.42) }));
  }

  // 3-point weighted smoothing (0.25 / 0.50 / 0.25)
  const smoothed: TrackPoint[] = deduped.map((p, idx) => {
    if (idx === 0 || idx === deduped.length - 1) {
      return { t: p.t, cx: round4(p.cx), cy: round4(p.cy ?? 0.42) };
    }
    const prev = deduped[idx - 1];
    const next = deduped[idx + 1];
    const cx = prev.cx * 0.25 + p.cx * 0.5 + next.cx * 0.25;
    const cy = (prev.cy ?? 0.42) * 0.25 + (p.cy ?? 0.42) * 0.5 + (next.cy ?? 0.42) * 0.25;
    return { t: p.t, cx: round4(cx), cy: round4(cy) };
  });

  // Deadzone stabilization: ignore tiny < 0.025 horizontal drifts so framing stays rock-steady
  for (let i = 1; i < smoothed.length; i++) {
    if (Math.abs(smoothed[i].cx - smoothed[i - 1].cx) < 0.025) {
      smoothed[i].cx = smoothed[i - 1].cx;
    }
  }

  return smoothed;
}

/**
 * Builds an FFmpeg crop `x` expression that smoothly pans a 9:16 vertical window
 * to keep the tracked person centered across the clip timeline.
 *
 * Assumes the source video has been scaled to `scale=-2:outH` (or increase to outW x outH)
 * so its horizontal width is `scaledW = max(outW, round(srcW * outH / srcH))`.
 */
export function buildTrackCropXExpr(
  points: TrackPoint[] | null | undefined,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
): string {
  const safeSrcW = Math.max(16, srcW || 1280);
  const safeSrcH = Math.max(16, srcH || 720);
  const scaledW = Math.max(outW, Math.round((safeSrcW * outH) / safeSrcH));
  const maxX = Math.max(0, scaledW - outW);
  if (maxX <= 2) return '0';

  const smoothed = smoothTrackPoints(points || []);
  const cxToX = (cx: number) => Math.round(clamp(cx * scaledW - outW / 2, 0, maxX));

  if (smoothed.length === 0) {
    return String(Math.round(maxX / 2));
  }
  if (smoothed.length === 1) {
    return String(cxToX(smoothed[0].cx));
  }

  // Cap keyframes to 10 so FFmpeg expression stays compact and fast
  const sampled: TrackPoint[] = [];
  if (smoothed.length <= 10) {
    sampled.push(...smoothed);
  } else {
    for (let i = 0; i < 10; i++) {
      const idx = Math.round((i * (smoothed.length - 1)) / 9);
      sampled.push(smoothed[idx]);
    }
  }

  // If every point maps to nearly the same X pixel, emit a clean static integer
  const xs = sampled.map((p) => cxToX(p.cx));
  if (Math.max(...xs) - Math.min(...xs) <= 8) {
    const avg = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
    return String(clamp(avg, 0, maxX));
  }

  // Build piecewise-linear nested if(lt(t, t_next), lerp, ...) expression
  let expr = String(xs[xs.length - 1]);
  for (let i = sampled.length - 2; i >= 0; i--) {
    const t0 = sampled[i].t;
    const t1 = sampled[i + 1].t;
    const x0 = xs[i];
    const x1 = xs[i + 1];
    const dt = Math.max(0.05, Number((t1 - t0).toFixed(2)));
    const segExpr =
      x0 === x1
        ? String(x0)
        : `${x0}+(${x1 - x0})*(t-${t0.toFixed(2)})/${dt.toFixed(2)}`;
    expr = `if(lt(t,${t1.toFixed(2)}),${segExpr},${expr})`;
  }
  // Hold first position for any t before first sample
  if (sampled[0].t > 0.05) {
    expr = `if(lt(t,${sampled[0].t.toFixed(2)}),${xs[0]},${expr})`;
  }

  return `clip(${expr},0,${maxX})`;
}

/**
 * Selects the best automatic vertical layout based on visual scene analysis.
 */
export function chooseAutoLayout(
  analysis: VideoFramingAnalysis | null | undefined,
  creatorHasCustomFacecam = false,
): 'split_gameplay' | 'gameplay' | 'track' | 'split' {
  if (!analysis) return 'track';
  if (analysis.hasFacecam && analysis.sourceFacecam) {
    return creatorHasCustomFacecam ? 'gameplay' : 'split_gameplay';
  }
  if (analysis.videoType === 'podcast_two_person') {
    return 'split';
  }
  return 'track';
}

export function resolveEffectiveLayout(
  requestedLayout: string,
  analysis: VideoFramingAnalysis | null | undefined,
  creatorHasCustomFacecam = false,
): string {
  if (!requestedLayout || requestedLayout === 'smart') {
    return chooseAutoLayout(analysis, creatorHasCustomFacecam);
  }
  return requestedLayout;
}

/**
 * Analyzes evenly-spaced frames from the source video via Gemini Vision to detect:
 * - Whether there is a streamer webcam / facecam overlay and its EXACT bounding box
 * - Whether the video is gaming+facecam, talking-head, two-person podcast, or general
 * - Where the primary person/subject sits horizontally
 */
export async function analyzeVideoFraming(opts: {
  videoPath: string;
  duration: number;
  srcW: number;
  srcH: number;
  uid?: string;
  creator?: string | null;
  place?: string;
}): Promise<VideoFramingAnalysis | null> {
  const c = currentAiConfig();
  if (c.provider !== 'gemini' || !c.key) return null;
  // Vertical source videos already fill 9:16
  if (opts.srcH >= opts.srcW) {
    return {
      videoType: 'general',
      hasFacecam: false,
      sourceFacecam: null,
      primarySubjectX: 0.5,
      recommendedLayout: 'track',
      confidence: 1,
      summary: 'Source video is already vertical.',
    };
  }

  const dur = Math.max(2, opts.duration || 10);
  const timestamps = [0.12, 0.35, 0.62, 0.85].map((f) => Number((dur * f).toFixed(2)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-vis-'));

  try {
    const frames = await extractSampleFrames(opts.videoPath, timestamps, tmpDir, 640);
    if (frames.length === 0) return null;

    const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    for (const f of frames) {
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: fs.readFileSync(f.path).toString('base64'),
        },
      });
    }
    parts.push({
      text: `You are an expert vertical video editor inspecting ${frames.length} evenly-spaced frames from a ${opts.srcW}x${opts.srcH} widescreen video.

Identify the exact visual layout so we can reframe it into a 9:16 vertical short properly:
1. video_type:
   - "gaming_facecam": gameplay/screen capture with a picture-in-picture webcam box showing a person (in ANY corner or side edge: top-left, top-right, middle-right, bottom-left, bottom-right, etc.).
   - "talking_head": a person/speaker on camera (vlog, reaction, interview, commentary, studio) without a separate gameplay PiP overlay.
   - "podcast_two_person": two people clearly seated on the left half and right half of the frame.
   - "general": gameplay without a webcam, scenery, screen tutorial, or other footage.
2. has_facecam: true ONLY if there is a distinct webcam/facecam overlay box (or clearly framed reaction camera inset) over gameplay/screen content.
3. facecam_box: if has_facecam is true, return the TIGHT normalized bounding box { x, y, w, h } (values 0.0 to 1.0, where x=0 is left edge, y=0 is top edge) around the webcam overlay (including the person's head and shoulders cleanly). Double-check whether the webcam is top-right, middle-right, bottom-right, top-left, or bottom-left — do NOT guess bottom-right unless it is actually there!
4. primary_subject_x: normalized horizontal center (0.0 to 1.0) of the main person or focal action across these frames.
5. confidence: 0.0 to 1.0.
6. summary: one short plain-English phrase describing the framing (e.g. "Gameplay with streamer webcam in top-right corner" or "Single speaker slightly right of center").`,
    });

    const ai = getVisionClient(c.key);
    for (const model of VISION_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                video_type: { type: Type.STRING },
                has_facecam: { type: Type.BOOLEAN },
                facecam_box: {
                  type: Type.OBJECT,
                  properties: {
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    w: { type: Type.NUMBER },
                    h: { type: Type.NUMBER },
                  },
                },
                primary_subject_x: { type: Type.NUMBER },
                confidence: { type: Type.NUMBER },
                summary: { type: Type.STRING },
              },
              required: ['video_type', 'has_facecam', 'primary_subject_x', 'confidence', 'summary'],
            },
          },
        });

        const tokensIn = response.usageMetadata?.promptTokenCount ?? frames.length * 300;
        const tokensOut = response.usageMetadata?.candidatesTokenCount ?? 120;
        if (opts.uid) {
          recordUsage(opts.uid, tokensIn, tokensOut, 'framing analysis', opts.creator ?? null, opts.place || '');
        }

        const raw = JSON.parse((response.text ?? '{}').trim()) as Record<string, unknown>;
        const rawType = String(raw.video_type || 'general');
        const videoType: DetectedVideoType =
          rawType === 'gaming_facecam' || rawType === 'talking_head' || rawType === 'podcast_two_person'
            ? rawType
            : 'general';
        const sourceFacecam = raw.has_facecam ? normalizeSourceBox(raw.facecam_box) : null;
        const hasFacecam = Boolean(raw.has_facecam && sourceFacecam);
        const primarySubjectX = clamp(Number(raw.primary_subject_x) || 0.5, 0.05, 0.95);
        const confidence = clamp(Number(raw.confidence) || 0.7, 0, 1);
        const summary = String(raw.summary || '').trim().slice(0, 140);

        const base: VideoFramingAnalysis = {
          videoType: hasFacecam ? 'gaming_facecam' : videoType,
          hasFacecam,
          sourceFacecam,
          primarySubjectX: round4(primarySubjectX),
          recommendedLayout: 'track',
          confidence: round4(confidence),
          summary: summary || (hasFacecam ? 'Detected gameplay with webcam overlay' : 'Detected widescreen footage'),
        };
        base.recommendedLayout = chooseAutoLayout(base, false);
        return base;
      } catch (err) {
        if (isAuthAiError(err)) return null;
        if (isTransientAiError(err)) {
          await sleep(500);
          continue;
        }
      }
    }
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Tracks the active speaker / main person across a single clip's timeline using a single
 * batched multi-frame Gemini Vision call, returning smoothed horizontal pan keyframes.
 */
export async function trackClipPerson(opts: {
  videoPath: string;
  clipStart: number;
  clipEnd: number;
  fallbackSubjectX?: number;
  uid?: string;
  creator?: string | null;
  place?: string;
}): Promise<TrackPoint[]> {
  const fallbackX = clamp(opts.fallbackSubjectX ?? 0.5, 0.1, 0.9);
  const c = currentAiConfig();
  if (c.provider !== 'gemini' || !c.key) {
    return [{ t: 0, cx: fallbackX, cy: 0.42 }];
  }

  const clipDur = Math.max(1, opts.clipEnd - opts.clipStart);
  const numSamples = Math.max(3, Math.min(8, Math.round(clipDur / 3.5) + 1));
  const relTimes: number[] = [];
  for (let i = 0; i < numSamples; i++) {
    const frac = numSamples === 1 ? 0.5 : i / (numSamples - 1);
    const rel = Number((frac * Math.max(0.2, clipDur - 0.25) + 0.1).toFixed(2));
    relTimes.push(rel);
  }
  const absTimes = relTimes.map((rt) => Number((opts.clipStart + rt).toFixed(2)));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-trk-'));

  try {
    const frames = await extractSampleFrames(opts.videoPath, absTimes, tmpDir, 512);
    if (frames.length === 0) {
      return [{ t: 0, cx: fallbackX, cy: 0.42 }];
    }

    const parts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    const labels: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const rel = Number(Math.max(0, frames[i].t - opts.clipStart).toFixed(2));
      labels.push(`Frame ${i} (t=${rel}s)`);
      parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: fs.readFileSync(frames[i].path).toString('base64'),
        },
      });
    }

    parts.push({
      text: `You are a camera operator tracking the primary person / active speaker across ${frames.length} chronological video frames: ${labels.join(', ')}.

For EACH frame (index 0 to ${frames.length - 1}), return the horizontal center cx (0.0 = far left edge, 0.5 = dead center, 1.0 = far right edge) and vertical center cy (0.0 = top, 1.0 = bottom) of:
- The active speaker's face (preferred if people are visible), OR
- The main person's torso/face, OR
- The main visual action focal point if no person is visible in that frame.

Keep tracking smooth and consistent on the same main person unless another speaker clearly takes focus.`,
    });

    const ai = getVisionClient(c.key);
    for (const model of VISION_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                points: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      frame: { type: Type.INTEGER },
                      cx: { type: Type.NUMBER },
                      cy: { type: Type.NUMBER },
                    },
                    required: ['frame', 'cx'],
                  },
                },
              },
              required: ['points'],
            },
          },
        });

        const tokensIn = response.usageMetadata?.promptTokenCount ?? frames.length * 260;
        const tokensOut = response.usageMetadata?.candidatesTokenCount ?? 120;
        if (opts.uid) {
          recordUsage(opts.uid, tokensIn, tokensOut, 'person tracking', opts.creator ?? null, opts.place || '');
        }

        const parsed = JSON.parse((response.text ?? '{}').trim()) as {
          points?: Array<{ frame?: number; cx?: number; cy?: number }>;
        };
        const rawPoints: TrackPoint[] = [];
        for (const pt of parsed.points || []) {
          const idx = Math.round(Number(pt.frame));
          if (idx < 0 || idx >= frames.length) continue;
          const rel = Number(Math.max(0, frames[idx].t - opts.clipStart).toFixed(2));
          rawPoints.push({
            t: rel,
            cx: clamp(Number(pt.cx), 0.05, 0.95),
            cy: Number.isFinite(pt.cy) ? clamp(Number(pt.cy), 0.05, 0.95) : 0.42,
          });
        }

        const smoothed = smoothTrackPoints(rawPoints);
        if (smoothed.length > 0) return smoothed;
      } catch (err) {
        if (isAuthAiError(err)) break;
        if (isTransientAiError(err)) {
          await sleep(400);
          continue;
        }
      }
    }

    return [{ t: 0, cx: fallbackX, cy: 0.42 }];
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
