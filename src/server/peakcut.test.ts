import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelCandidates,
  distributeWordsOverDuration,
  explainAiError,
  isSubtitleCoverageAdequate,
  isTransientAiError,
  segmentsToWordStamps,
} from './ai.ts';
import {
  chunkTranscriptLines,
  cleanAiText,
  loudZscore,
  makeLines,
  overlaps,
  pickAudioPeakClips,
  safeInput,
  snapClipBoundsToWords,
  tidyClip,
} from './brain.ts';
import { detectGame, nameOfGame, tagsOfGame } from './games.ts';
import { applyHashtags, channelTag, makeHashtags } from './hashtags.ts';
import { buildAss, buildFilterGraph, geometry, groupWords } from './render.ts';
import {
  buildTrackCropXExpr,
  chooseAutoLayout,
  normalizeSourceBox,
  resolveEffectiveLayout,
  smoothTrackPoints,
  sourceBoxToCropPx,
} from './vision.ts';
import {
  DEFAULT_FACECAM,
  DEFAULT_SPLIT_RATIO,
  facecamToOverlayPx,
  MAX_SPLIT_RATIO,
  MIN_FACECAM_H,
  MIN_FACECAM_W,
  MIN_SPLIT_RATIO,
  moveFacecamRect,
  normalizeFacecam,
  normalizeSplitRatio,
  resizeFacecamRect,
  splitHeightsPx,
} from './facecam.ts';
import {
  explainDownloadError,
  formatSectionTime,
  parseJson3Subtitles,
  parseYtDlpProgressLine,
} from './ytdlp.ts';

test('games: detects longest alias first (GTA 6 before GTA)', () => {
  const [name, tags] = detectGame('Playing GTA 6 trailer reaction live!');
  assert.equal(name, 'Grand Theft Auto VI');
  assert.ok(tags.includes('GTA6'));
  assert.equal(nameOfGame('valo'), 'Valorant');
  assert.deepEqual(tagsOfGame('Valorant'), ['Valorant', 'ValClips']);
});

test('hashtags: generates relevant tags and preserves fixed descriptions', () => {
  assert.equal(channelTag('Kai Cenat Live Official'), 'kaicenat');
  const tags = makeHashtags({
    text: 'Clutch headshot ace in Valorant radiant lobby Valorant ace',
    title: 'Insane Valorant clutch moment',
    uploader: 'TenZ Live',
    game: 'Valorant',
    category: 'clutch',
  });
  assert.ok(tags.length >= 3 && tags.length <= 5);
  assert.equal(tags[0], 'valorant');
  assert.ok(tags.includes('tenz'));

  const fixedClip = {
    start: 0,
    end: 20,
    description: 'Sponsor campaign text #partner',
    fixed_description: true,
    hashtags: ['partner'],
  };
  applyHashtags(fixedClip, [], 'Test', 'Creator', 'Valorant');
  assert.equal(fixedClip.description, 'Sponsor campaign text #partner');
});

test('render: geometry calculates vertical 9:16 layouts and auto-crops vertical inputs', () => {
  const blur = geometry(1920, 1080, 'blur');
  assert.equal(blur.layout, 'blur');
  assert.equal(blur.fgH, 608);

  const split = geometry(1920, 1080, 'split');
  assert.equal(split.layout, 'split');
  assert.equal(split.capY, 960);

  const verticalSrc = geometry(1080, 1920, 'blur');
  assert.equal(verticalSrc.layout, 'crop');
});

test('render: buildAss emits valid ASS script with hook box and animated caption events', () => {
  const words = [
    { w: 'No', s: 1.0, e: 1.3 },
    { w: 'way', s: 1.3, e: 1.7 },
    { w: 'clutch!', s: 1.7, e: 2.3 },
  ];
  assert.equal(groupWords(words, 2).length, 2);
  const ass = buildAss(words, 0.5, 5.0, 'INSANE CLUTCH', 'bounce', ['clutch'], 300, 1380);
  assert.ok(ass.includes('[Script Info]'));
  assert.ok(ass.includes('PlayResX: 1080'));
  assert.ok(ass.includes('INSANE CLUTCH'));
  assert.ok(ass.includes('\\fscx94\\fscy94'));
  assert.ok(buildFilterGraph('blur', 608).includes('boxblur'));
  assert.ok(buildFilterGraph('gameplay', 1920, [100, 100, 320, 240]).includes('overlay='));
});

test('brain: sanitizes untrusted text, computes loudness z-score, and picks non-overlapping audio peak clips', () => {
  assert.equal(safeInput('Hello <script> world'), 'Hello ‹script> world');
  assert.equal(cleanAiText('Check https://spam.com @user now!', 100), 'Check now!');

  const z = loudZscore([-30, -30, -29, -30, -8, -30, -30]);
  assert.ok(z[4] > 1.5);

  const lines = makeLines(
    [
      { w: 'Wait', s: 0, e: 0.4 },
      { w: 'what', s: 0.4, e: 0.8 },
      { w: 'happened!', s: 4.0, e: 4.5 },
    ],
    z,
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[1].loud, true);

  const picked = pickAudioPeakClips({
    duration: 45,
    loudness: Array.from({ length: 45 }, (_, i) => (i >= 10 && i <= 16 ? -6 : -28)),
    maxClips: 2,
    minLen: 10,
    maxLen: 20,
    title: 'Test stream',
    game: 'Valorant',
  });
  assert.ok(picked.length >= 1);
  assert.ok(picked[0].hashtags.includes('Valorant'));
  assert.equal(overlaps(0, 10, [{ start: 12, end: 22 }]), false);
  assert.equal(overlaps(0, 10, [{ start: 4, end: 14 }]), true);

  const tidied = tidyClip({ score: 150, hook: 'visit https://evil.com wow', category: 'clutch' }, 2, 18, 'Valorant');
  assert.equal(tidied.score, 100);
  assert.equal(tidied.hook, 'VISIT WOW');
});

test('ai: distributes transcribed words evenly and builds resilient Gemini fallback chain', () => {
  const words = distributeWordsOverDuration('Hello world this is PeakCut', 10);
  assert.equal(words.length, 5);
  assert.ok(words[0].s >= 0 && words[4].e <= 10);
  assert.ok(words[2].s > words[1].s);

  const candidates = buildModelCandidates(['gemini-4-hydrogen'], 'gemini');
  assert.deepEqual(candidates, ['gemini-4-hydrogen', 'gemini-3.1-flash-lite']);

  const err503 = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
  assert.equal(isTransientAiError(err503), true);
  const friendly = explainAiError(err503);
  assert.ok(friendly.includes('temporarily busy'));
  assert.ok(!friendly.includes('{"error"'));
});

test('jobs: timestamp stamp produces strictly alphanumeric-dash job IDs without dots', () => {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})/, '$1-$2');
  const jid = `${stamp}-abcdef1234`;
  assert.match(jid, /^\d{8}-\d{6}-[0-9a-f]{10}$/);
  assert.match(jid, /^[\w-]{8,60}$/);
});

test('ytdlp: formats download sections, parses progress, decodes json3 captions, and explains errors', () => {
  assert.equal(formatSectionTime(0), '0:00');
  assert.equal(formatSectionTime(125), '2:05');
  assert.equal(formatSectionTime(3665), '1:01:05');

  assert.equal(parseYtDlpProgressLine('[download]  42.5% of   10.00MiB at  2.00MiB/s'), 0.425);
  assert.equal(parseYtDlpProgressLine('[info] Downloading video'), null);

  const json3 = JSON.stringify({
    events: [
      {
        tStartMs: 10000,
        dDurationMs: 2000,
        segs: [
          { utf8: 'Hello ', tOffsetMs: 0 },
          { utf8: 'world!', tOffsetMs: 600 },
        ],
      },
    ],
  });
  const words = parseJson3Subtitles(json3, 10);
  assert.equal(words.length, 2);
  assert.equal(words[0].w, 'Hello');
  assert.equal(words[0].s, 0);
  assert.equal(words[1].w, 'world!');
  assert.equal(words[1].s, 0.6);

  const botMsg = explainDownloadError(
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot.",
    'https://www.youtube.com/watch?v=abc',
    false,
  );
  assert.ok(botMsg.includes("YouTube isn't letting PeakCut download"));
  assert.ok(botMsg.includes('Settings → Connected apps'));
});

test('facecam: normalizes, clamps, moves, and resizes from all four corners accurately', () => {
  // Normalization + percentage conversion + clamping
  assert.deepEqual(normalizeFacecam({ x: 62, y: 4, w: 34, h: 19 }), { x: 0.62, y: 0.04, w: 0.34, h: 0.19 });
  assert.equal(normalizeFacecam(null), null);
  assert.equal(normalizeFacecam({ x: 'bad', y: 0, w: 0.3, h: 0.2 }), null);

  const clampedSmall = normalizeFacecam({ x: -0.2, y: 0.99, w: 0.02, h: 0.01 });
  assert.ok(clampedSmall);
  assert.equal(clampedSmall.w, MIN_FACECAM_W);
  assert.equal(clampedSmall.h, MIN_FACECAM_H);
  assert.equal(clampedSmall.x, 0);
  assert.ok(Math.abs(clampedSmall.y + clampedSmall.h - 1) < 1e-4);

  // Drag reposition stays clamped within [0..1]
  const moved = moveFacecamRect(DEFAULT_FACECAM, -0.5, 0.2);
  assert.equal(moved.x, 0.12);
  assert.equal(moved.y, 0.24);
  assert.equal(moved.w, DEFAULT_FACECAM.w);
  assert.equal(moved.h, DEFAULT_FACECAM.h);

  const movedOut = moveFacecamRect(DEFAULT_FACECAM, 0.9, -0.5);
  assert.ok(Math.abs(movedOut.x + movedOut.w - 1) < 1e-4);
  assert.equal(movedOut.y, 0);

  // Corner resizing anchors the opposite corner
  const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.3 };

  const se = resizeFacecamRect(start, 'se', 0.1, 0.15);
  assert.deepEqual(se, { x: 0.2, y: 0.2, w: 0.5, h: 0.45 });

  const nw = resizeFacecamRect(start, 'nw', -0.1, -0.05);
  assert.deepEqual(nw, { x: 0.1, y: 0.15, w: 0.5, h: 0.35 });

  const ne = resizeFacecamRect(start, 'ne', 0.1, -0.1);
  assert.deepEqual(ne, { x: 0.2, y: 0.1, w: 0.5, h: 0.4 });

  const sw = resizeFacecamRect(start, 'sw', -0.05, 0.1);
  assert.deepEqual(sw, { x: 0.15, y: 0.2, w: 0.45, h: 0.4 });

  // Minimum size enforced when collapsing from nw toward se
  const minCollapsed = resizeFacecamRect(start, 'nw', 0.9, 0.9);
  assert.equal(minCollapsed.w, MIN_FACECAM_W);
  assert.equal(minCollapsed.h, MIN_FACECAM_H);
  assert.ok(Math.abs(minCollapsed.x + minCollapsed.w - 0.6) < 1e-4);
  assert.ok(Math.abs(minCollapsed.y + minCollapsed.h - 0.5) < 1e-4);

  // Pixel overlay conversion & FFmpeg filter graph with FacecamRect
  const px = facecamToOverlayPx({ x: 0.1, y: 0.05, w: 0.4, h: 0.25 }, 1080, 1920);
  assert.equal(px.x, 108);
  assert.equal(px.y, 96);
  assert.equal(px.w % 2, 0);
  assert.equal(px.h % 2, 0);

  const fg = buildFilterGraph('gameplay', 1920, { x: 0.1, y: 0.05, w: 0.4, h: 0.25 });
  assert.ok(fg.includes(`overlay=${px.x}:${px.y}`));
  assert.ok(fg.includes(`scale=${px.w}:${px.h}`));
});

test('layouts: splitscreen gameplay + facecam and gameplay + movable facecam compute even FFmpeg graphs', () => {
  // Split ratio normalization & clamping
  assert.equal(normalizeSplitRatio(undefined), DEFAULT_SPLIT_RATIO);
  assert.equal(normalizeSplitRatio(45), 0.45);
  assert.equal(normalizeSplitRatio(0.1), MIN_SPLIT_RATIO);
  assert.equal(normalizeSplitRatio(0.9), MAX_SPLIT_RATIO);

  // Even-aligned heights that sum exactly to 1920
  const defSplit = splitHeightsPx(0.4, 1920);
  assert.equal(defSplit.topH, 768);
  assert.equal(defSplit.bottomH, 1152);
  assert.equal(defSplit.topH % 2, 0);
  assert.equal(defSplit.bottomH % 2, 0);
  assert.equal(defSplit.topH + defSplit.bottomH, 1920);

  const halfSplit = splitHeightsPx(0.5, 1920);
  assert.equal(halfSplit.topH, 960);
  assert.equal(halfSplit.bottomH, 960);

  // Geometry places captions cleanly near the split seam
  const sgGeom = geometry(1920, 1080, 'split_gameplay', 0.4);
  assert.equal(sgGeom.layout, 'split_gameplay');
  assert.equal(sgGeom.capY, 768);

  // Filter graph for split_gameplay stacks top facecam + bottom gameplay
  const sgFg = buildFilterGraph('split_gameplay', 1920, null, 0.4);
  assert.ok(sgFg.includes('scale=1080:768'));
  assert.ok(sgFg.includes('scale=1080:1152'));
  assert.ok(sgFg.includes('[t][b]vstack,setsar=1[v0];'));

  // Filter graph for split_gameplay with legacy pixel facecam coordinates
  const sgLegacy = buildFilterGraph('split_gameplay', 1920, [900, 500, 320, 200], 0.5);
  assert.ok(sgLegacy.includes('crop=320:200:900:500'));
  assert.ok(sgLegacy.includes('scale=1080:960'));

  // Filter graph for gameplay + movable facecam defaults to DEFAULT_FACECAM when null
  const defOv = facecamToOverlayPx(DEFAULT_FACECAM, 1080, 1920);
  const gpDefault = buildFilterGraph('gameplay', 1920, null);
  assert.ok(gpDefault.includes(`overlay=${defOv.x}:${defOv.y}`));
  assert.ok(gpDefault.includes(`scale=${defOv.w}:${defOv.h}`));
});

test('transcription: aligns chunked timestamped segments and validates subtitle coverage across full video', () => {
  const words = segmentsToWordStamps(
    [
      { s: 5.0, e: 7.4, text: 'Wait did you see that?' },
      { s: 12.0, e: 14.5, text: 'That was actually insane!' },
    ],
    240,
    240,
  );
  assert.equal(words.length, 9);
  assert.equal(words[0].s, 245);
  assert.ok(words[4].e <= 247.45);
  assert.equal(words[5].s, 252);
  assert.ok(words[8].e <= 254.55);
  for (let i = 1; i < words.length; i++) {
    assert.ok(words[i].s >= words[i - 1].s);
  }

  // Partial subtitles (only first 15s of a 600s video) must be rejected so full Gemini transcription runs
  const partialSubs = Array.from({ length: 12 }, (_, i) => ({ w: `w${i}`, s: i, e: i + 0.5 }));
  assert.equal(isSubtitleCoverageAdequate(partialSubs, 600), false);

  // Full coverage subtitles pass cleanly
  const fullSubs = Array.from({ length: 120 }, (_, i) => ({ w: `word${i}`, s: i * 4, e: i * 4 + 0.8 }));
  assert.equal(isSubtitleCoverageAdequate(fullSubs, 500), true);
});

test('scouting: chunks long transcripts without truncation and snaps clips cleanly to sentence boundaries', () => {
  const longLines = Array.from({ length: 180 }, (_, i) => ({
    s: i * 5,
    e: i * 5 + 4.5,
    text: `Line number ${i} discussing an exciting play and reaction with detailed commentary across the whole video.`,
    loud: i % 15 === 0,
    chat: false,
  }));
  const chunks = chunkTranscriptLines(longLines, 4000, 4);
  assert.ok(chunks.length >= 4);
  assert.equal(chunks[0].startSec, 0);
  // Last chunk MUST reach the very end of the video (no silent truncation!)
  assert.equal(chunks[chunks.length - 1].endSec, longLines[longLines.length - 1].e);
  // Adjacent chunks overlap cleanly
  assert.ok(chunks[1].startSec < chunks[0].endSec);

  // Sentence-boundary snapping
  const words = [
    { w: 'Okay', s: 9.2, e: 9.6 },
    { w: 'watch', s: 9.6, e: 10.0 },
    { w: 'this.', s: 10.0, e: 10.4 },
    { w: 'No', s: 11.1, e: 11.4 },
    { w: 'way', s: 11.4, e: 11.8 },
    { w: 'I', s: 11.8, e: 12.0 },
    { w: 'hit', s: 12.0, e: 12.3 },
    { w: 'that!', s: 26.8, e: 27.3 },
    { w: 'Next', s: 28.5, e: 29.0 },
  ];
  const snapped = snapClipBoundsToWords(11.6, 26.4, words, 120, 10, 40);
  // Snaps start back to "No" (11.1 - 0.15 = 10.95) and end forward to after "that!" (27.3 + 0.25 = 27.55)
  assert.equal(snapped.start, 10.95);
  assert.equal(snapped.end, 27.55);
});

test('vision: normalizes detected source facecam, smooths person tracking, and generates valid FFmpeg tracking graphs', () => {
  // Rejects full-screen or tiny boxes
  assert.equal(normalizeSourceBox({ x: 0, y: 0, w: 0.95, h: 0.95 }), null);
  assert.equal(normalizeSourceBox({ x: 0.1, y: 0.1, w: 0.02, h: 0.02 }), null);

  // Accepts top-right webcam box (NOT bottom-right!)
  const topRight = normalizeSourceBox({ x: 0.72, y: 0.08, w: 0.25, h: 0.28 });
  assert.deepEqual(topRight, { x: 0.72, y: 0.08, w: 0.25, h: 0.28 });
  const cropPx = sourceBoxToCropPx(topRight!, 1920, 1080);
  assert.equal(cropPx.x % 2, 0);
  assert.equal(cropPx.y % 2, 0);
  assert.equal(cropPx.w % 2, 0);
  assert.equal(cropPx.h % 2, 0);
  assert.ok(cropPx.y < 150); // genuinely top-right, not bottom-right!

  // split_gameplay and gameplay filter graphs use the ACTUAL detected source facecam crop!
  const sgDetected = buildFilterGraph('split_gameplay', 1920, null, 0.4, {
    srcW: 1920,
    srcH: 1080,
    sourceFacecam: topRight,
  });
  assert.ok(sgDetected.includes(`crop=${cropPx.w}:${cropPx.h}:${cropPx.x}:${cropPx.y}`));
  assert.ok(!sgDetected.includes('crop=iw*0.30:ih*0.34:iw*0.70:ih*0.66'));

  const gpDetected = buildFilterGraph('gameplay', 1920, { x: 0.05, y: 0.05, w: 0.32, h: 0.2 }, null, {
    srcW: 1920,
    srcH: 1080,
    sourceFacecam: topRight,
  });
  assert.ok(gpDetected.includes(`crop=${cropPx.w}:${cropPx.h}:${cropPx.x}:${cropPx.y}`));

  // Person tracking smoothing & piecewise-linear FFmpeg crop expression
  const smoothed = smoothTrackPoints([
    { t: 0, cx: 0.25 },
    { t: 3, cx: 0.52 },
    { t: 6, cx: 0.78 },
  ]);
  assert.equal(smoothed.length, 3);
  assert.ok(smoothed[0].cx < smoothed[1].cx && smoothed[1].cx < smoothed[2].cx);

  const expr = buildTrackCropXExpr(smoothed, 1920, 1080, 1080, 1920);
  assert.ok(expr.startsWith('clip(if(lt(t,'));
  assert.ok(expr.endsWith(',0,2333)'));

  const trackFg = buildFilterGraph('track', 1920, null, null, {
    srcW: 1920,
    srcH: 1080,
    trackPoints: smoothed,
  });
  assert.ok(trackFg.includes(`crop=1080:1920:'${expr}':0`));

  // Auto layout chooser picks split_gameplay / gameplay / split / track intelligently
  assert.equal(
    chooseAutoLayout(
      {
        videoType: 'gaming_facecam',
        hasFacecam: true,
        sourceFacecam: topRight,
        primarySubjectX: 0.5,
        recommendedLayout: 'split_gameplay',
        confidence: 0.9,
        summary: 'Gameplay with top-right webcam',
      },
      false,
    ),
    'split_gameplay',
  );
  assert.equal(
    chooseAutoLayout(
      {
        videoType: 'gaming_facecam',
        hasFacecam: true,
        sourceFacecam: topRight,
        primarySubjectX: 0.5,
        recommendedLayout: 'split_gameplay',
        confidence: 0.9,
        summary: 'Gameplay with top-right webcam',
      },
      true,
    ),
    'gameplay',
  );
  assert.equal(
    resolveEffectiveLayout(
      'smart',
      {
        videoType: 'talking_head',
        hasFacecam: false,
        sourceFacecam: null,
        primarySubjectX: 0.72,
        recommendedLayout: 'track',
        confidence: 0.9,
        summary: 'Single speaker right of center',
      },
      false,
    ),
    'track',
  );
  assert.equal(resolveEffectiveLayout('blur', null, false), 'blur');
});




