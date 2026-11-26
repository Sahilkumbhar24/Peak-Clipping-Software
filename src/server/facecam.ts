export interface FacecamRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FacecamCorner = 'nw' | 'ne' | 'sw' | 'se';

export const DEFAULT_FACECAM: FacecamRect = {
  x: 0.62,
  y: 0.04,
  w: 0.34,
  h: 0.19,
};

export const MIN_FACECAM_W = 0.12;
export const MIN_FACECAM_H = 0.08;

export const DEFAULT_SPLIT_RATIO = 0.4;
export const MIN_SPLIT_RATIO = 0.25;
export const MAX_SPLIT_RATIO = 0.6;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function isFacecamRect(value: unknown): value is FacecamRect {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.w === 'number' &&
    typeof r.h === 'number' &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.w) &&
    Number.isFinite(r.h)
  );
}

/**
 * Validates and clamps a normalized facecam rectangle in [0..1] stage coordinates.
 * Also accepts percentage values (0..100) if any coordinate > 1, converting them cleanly.
 */
export function normalizeFacecam(raw: unknown): FacecamRect | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  let x = Number(rec.x);
  let y = Number(rec.y);
  let w = Number(rec.w);
  let h = Number(rec.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;

  // If caller supplied percentages (0..100), normalize to 0..1
  if (w > 1 || h > 1 || x > 1 || y > 1) {
    x /= 100;
    y /= 100;
    w /= 100;
    h /= 100;
  }

  w = clamp(w, MIN_FACECAM_W, 1);
  h = clamp(h, MIN_FACECAM_H, 1);
  x = clamp(x, 0, Math.max(0, 1 - w));
  y = clamp(y, 0, Math.max(0, 1 - h));

  return {
    x: round4(x),
    y: round4(y),
    w: round4(w),
    h: round4(h),
  };
}

/**
 * Moves a facecam rectangle by normalized deltas (dx, dy) while keeping it strictly inside [0..1].
 */
export function moveFacecamRect(rect: FacecamRect, dx: number, dy: number): FacecamRect {
  const base = normalizeFacecam(rect) ?? { ...DEFAULT_FACECAM };
  const x = clamp(base.x + dx, 0, Math.max(0, 1 - base.w));
  const y = clamp(base.y + dy, 0, Math.max(0, 1 - base.h));
  return {
    x: round4(x),
    y: round4(y),
    w: base.w,
    h: base.h,
  };
}

/**
 * Resizes a facecam rectangle from one of its four corners ('nw', 'ne', 'sw', 'se'),
 * anchoring the opposite corner, enforcing minimum dimensions, and clamping to [0..1].
 */
export function resizeFacecamRect(
  rect: FacecamRect,
  corner: FacecamCorner,
  dx: number,
  dy: number,
): FacecamRect {
  const base = normalizeFacecam(rect) ?? { ...DEFAULT_FACECAM };
  let left = base.x;
  let top = base.y;
  let right = base.x + base.w;
  let bottom = base.y + base.h;

  if (corner === 'nw' || corner === 'sw') {
    left = clamp(base.x + dx, 0, right - MIN_FACECAM_W);
  } else {
    right = clamp(base.x + base.w + dx, left + MIN_FACECAM_W, 1);
  }

  if (corner === 'nw' || corner === 'ne') {
    top = clamp(base.y + dy, 0, bottom - MIN_FACECAM_H);
  } else {
    bottom = clamp(base.y + base.h + dy, top + MIN_FACECAM_H, 1);
  }

  return {
    x: round4(left),
    y: round4(top),
    w: round4(right - left),
    h: round4(bottom - top),
  };
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Converts a normalized FacecamRect to even-aligned pixel coordinates for FFmpeg overlay on (stageW x stageH).
 */
export function facecamToOverlayPx(
  rect: FacecamRect,
  stageW: number,
  stageH: number,
): { x: number; y: number; w: number; h: number } {
  const norm = normalizeFacecam(rect) ?? { ...DEFAULT_FACECAM };
  const w = clamp(even(norm.w * stageW), 80, even(stageW));
  const h = clamp(even(norm.h * stageH), 80, even(stageH));
  const x = clamp(Math.round(norm.x * stageW), 0, Math.max(0, stageW - w));
  const y = clamp(Math.round(norm.y * stageH), 0, Math.max(0, stageH - h));
  return { x, y, w, h };
}

/**
 * Validates and clamps a splitscreen facecam height ratio in [MIN_SPLIT_RATIO..MAX_SPLIT_RATIO].
 * Accepts either normalized fractions (0.25..0.60) or percentages (25..60).
 */
export function normalizeSplitRatio(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_SPLIT_RATIO;
  let v = Number(raw);
  if (!Number.isFinite(v)) return DEFAULT_SPLIT_RATIO;
  if (v > 1) v /= 100;
  return round4(clamp(v, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO));
}

/**
 * Computes even-aligned top (facecam) and bottom (gameplay) heights for a 9:16 splitscreen output.
 */
export function splitHeightsPx(
  splitRatio: number | null | undefined,
  stageH: number,
): { topH: number; bottomH: number; ratio: number } {
  const ratio = normalizeSplitRatio(splitRatio);
  const totalH = even(stageH);
  const minH = even(MIN_SPLIT_RATIO * totalH);
  const maxH = even(MAX_SPLIT_RATIO * totalH);
  const topH = clamp(even(ratio * totalH), minH, maxH);
  const bottomH = Math.max(2, totalH - topH);
  return { topH, bottomH, ratio };
}
