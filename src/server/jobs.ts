import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isSubtitleCoverageAdequate, transcribeAudioWithGemini } from './ai.ts';
import { findClipsWithAi } from './brain.ts';
import * as config from './config.ts';
import { cleanDescription, cleanHook, creatorDir, getCreator } from './creators.ts';
import { DEFAULT_SPLIT_RATIO, normalizeFacecam, normalizeSplitRatio } from './facecam.ts';
import { detectGame } from './games.ts';
import { applyHashtags, TAG_IN_TEXT, type WordStamp } from './hashtags.ts';
import { extractAudioAndLoudness, extractThumbnail, getCachedPreview, probeVideo } from './media.ts';
import { LAYOUTS, renderClip, STYLES } from './render.ts';
import {
  analyzeVideoFraming,
  resolveEffectiveLayout,
  trackClipPerson,
  type VideoFramingAnalysis,
} from './vision.ts';
import { downloadVideoUrl } from './ytdlp.ts';
import {
  addCreatorLog,
  addNotice,
  bump,
  type ClipRecord,
  getState,
  type JobRecord,
} from './store.ts';

export const JOB_DEFAULTS = {
  max_clips: 6,
  min_len: 15,
  max_len: 60,
  style: 'bounce',
  layout: 'smart',
  quality: 720,
  range_start: null as number | null,
  range_end: null as number | null,
  captions: true,
  hook_text: '',
  description_text: '',
  lang: 'en',
  split_ratio: DEFAULT_SPLIT_RATIO,
};

const OPTION_LIMITS: Record<string, [number, number]> = {
  max_clips: [1, 20],
  min_len: [5, 120],
  max_len: [10, 180],
  quality: [360, 1080],
};

export function cleanOptions(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === 'captions') {
      if (typeof v !== 'boolean') throw new Error('Captions must be on or off.');
      out[k] = v;
      continue;
    }
    if (k === 'hook_text') {
      out[k] = cleanHook(v);
      continue;
    }
    if (k === 'description_text') {
      out[k] = cleanDescription(v);
      continue;
    }
    if (!(k in JOB_DEFAULTS) || v === '' || v === null || v === undefined) continue;
    if (k in OPTION_LIMITS) {
      const [lo, hi] = OPTION_LIMITS[k];
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error('Those options are not valid.');
      out[k] = Math.max(lo, Math.min(hi, Math.round(n)));
    } else if (k === 'style') {
      out[k] = typeof v === 'string' && v in STYLES ? v : JOB_DEFAULTS.style;
    } else if (k === 'layout') {
      out[k] = typeof v === 'string' && v in LAYOUTS ? v : JOB_DEFAULTS.layout;
    } else if (k === 'lang') {
      out[k] = v === 'ar' ? 'ar' : 'en';
    } else if (k === 'range_start' || k === 'range_end') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new Error('Invalid time range.');
      out[k] = Number(n.toFixed(2));
    } else if (k === 'split_ratio') {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error('Invalid split ratio.');
      out[k] = normalizeSplitRatio(n);
    }
  }
  return out;
}

export function cleanHashtags(v: unknown): string[] {
  const raw = typeof v === 'string' ? v.split(/[\s,]+/) : Array.isArray(v) ? v : [];
  return raw
    .slice(0, 50)
    .map((h) => String(h).replace(/\W/g, '').slice(0, 30))
    .filter(Boolean)
    .slice(0, 8);
}

export function publicJob(job: JobRecord) {
  return {
    id: job.id,
    kind: job.kind,
    creator: job.creator,
    created: job.created,
    source: {
      type: job.source.type,
      name: job.source.name,
      ...(job.source.url ? { url: job.source.url } : {}),
    },
    options: job.options,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    title: job.title,
    uploader: job.uploader,
    duration: job.duration,
    width: job.width,
    height: job.height,
    thumb: Boolean(job.thumb),
    game: job.game ?? null,
    lang: job.lang || 'en',
    source_facecam: job.source_facecam ?? null,
    video_type: job.video_type ?? null,
    recommended_layout: job.recommended_layout ?? null,
    framing_summary: job.framing_summary ?? '',
    transcript_info: job.transcript_info ?? null,
    clips: job.clips.map((c) => ({
      id: c.id,
      start: c.start,
      end: c.end,
      score: c.score,
      category: c.category,
      hook: c.hook,
      title: c.title,
      description: c.description,
      hashtags: c.hashtags,
      hashtags_in_description: Boolean(c.hashtags_in_description),
      fixed_description: Boolean(c.fixed_description),
      highlight_words: c.highlight_words,
      reason: c.reason,
      style: c.style,
      layout: c.layout,
      resolved_layout: c.resolved_layout ?? c.layout,
      captions: c.captions,
      status: c.status,
      version: c.version,
      file: c.file,
      cover: c.cover,
      error: c.error ?? null,
      made_at: c.made_at,
      facecam: c.facecam ?? null,
      source_facecam: c.source_facecam ?? job.source_facecam ?? null,
      tracked: Boolean(c.track_points && c.track_points.length > 0),
      spoken_excerpt: c.spoken_excerpt ?? '',
      split_ratio: c.split_ratio ?? DEFAULT_SPLIT_RATIO,
    })),
    error: job.error,
    ai: {
      tokens: job.ai?.tokens || 0,
      note: job.ai?.note || '',
      used: Boolean(job.ai?.model),
    },
  };
}

export function listJobs(uid: string): JobRecord[] {
  return Object.values(getState().jobs)
    .filter((j) => j.user === uid)
    .sort((a, b) => b.created - a.created);
}

export function getJob(uid: string, jid: string): JobRecord | null {
  if (!/^[\w-]{8,60}$/.test(jid)) return null;
  const j = getState().jobs[jid];
  return j && j.user === uid ? j : null;
}

export function busyCount(uid: string): number {
  return listJobs(uid).filter((j) => j.kind === 'video' && (j.status === 'queued' || j.status === 'running')).length;
}

export function createJob(opts: {
  uid: string;
  source: { type: 'file' | 'url' | 'live'; name: string; url?: string; path?: string };
  options?: Record<string, unknown>;
  creator?: string | null;
  kind?: 'video' | 'live';
}): JobRecord {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})(\d{6})/, '$1-$2');
  const jid = `${stamp}-${crypto.randomBytes(5).toString('hex')}`;
  const creatorObj = opts.creator ? getCreator(opts.uid, opts.creator) : null;
  const kind = opts.kind || 'video';

  let dir: string;
  let baseOpts: Record<string, unknown> = { ...JOB_DEFAULTS };
  if (creatorObj) {
    dir = path.join(creatorDir(opts.uid, creatorObj.id), kind === 'live' ? 'live' : 'videos', jid);
    baseOpts = {
      ...JOB_DEFAULTS,
      max_clips: creatorObj.max_clips,
      min_len: creatorObj.min_len,
      max_len: creatorObj.max_len,
      style: creatorObj.style,
      layout: creatorObj.layout,
      captions: creatorObj.captions,
      lang: creatorObj.lang,
      hook_text: creatorObj.hook_text,
      description_text: creatorObj.description_text,
      split_ratio: creatorObj.split_ratio ?? DEFAULT_SPLIT_RATIO,
    };
  } else {
    dir = path.join(config.userDir(opts.uid), 'jobs', jid);
  }

  fs.mkdirSync(path.join(dir, 'clips'), { recursive: true });
  const mergedOpts = { ...baseOpts, ...cleanOptions(opts.options || {}) };
  if (Number(mergedOpts.min_len) >= Number(mergedOpts.max_len)) {
    mergedOpts.min_len = Math.max(5, Number(mergedOpts.max_len) - 5);
  }

  const job: JobRecord = {
    id: jid,
    user: opts.uid,
    kind,
    creator: creatorObj ? creatorObj.id : null,
    dir,
    source_path: opts.source.path,
    created: Date.now() / 1000,
    source: opts.source,
    options: mergedOpts,
    status: kind === 'live' ? 'live' : 'queued',
    stage: kind === 'live' ? 'Recording stream' : 'Waiting',
    progress: 0,
    title: opts.source.name || 'Untitled video',
    uploader: creatorObj?.name || '',
    duration: 0,
    width: 1280,
    height: 720,
    has_audio: true,
    thumb: false,
    lang: String(mergedOpts.lang || 'en'),
    clips: [],
    error: null,
    ai: {},
  };

  if (opts.source.type === 'url' && opts.source.url) {
    const cached = getCachedPreview(opts.source.url);
    if (cached) {
      job.title = cached.title;
      job.uploader = cached.uploader || job.uploader;
      job.duration = cached.duration || 0;
    }
  }

  getState().jobs[jid] = job;
  bump(opts.uid);
  return job;
}

function readWords(job: JobRecord): WordStamp[] {
  const f = path.join(job.dir, 'words.json');
  try {
    if (fs.existsSync(f)) {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (Array.isArray(parsed)) return parsed as WordStamp[];
    }
  } catch {
    // ignore
  }
  return [];
}

function writeWords(job: JobRecord, words: WordStamp[]): void {
  fs.writeFileSync(path.join(job.dir, 'words.json'), JSON.stringify(words), 'utf-8');
}

export function spokenInClip(job: JobRecord, clip: ClipRecord): string {
  const words = readWords(job);
  return words
    .filter((w) => w.s >= clip.start - 0.5 && w.s <= clip.end + 0.5)
    .map((w) => w.w)
    .join(' ');
}

export function enqueueVideoJob(job: JobRecord): void {
  setImmediate(() => {
    void processVideoJob(job).catch((err) => {
      job.status = 'error';
      job.stage = 'Failed';
      job.error = err instanceof Error ? err.message : String(err);
      bump(job.user);
    });
  });
}

async function processVideoJob(job: JobRecord): Promise<void> {
  const update = (patch: Partial<JobRecord>) => {
    Object.assign(job, patch);
    bump(job.user);
  };

  let downloadedSubtitles: WordStamp[] = [];

  if (job.source.type === 'url') {
    const linkUrl = job.source.url || '';
    if (!linkUrl) {
      update({ status: 'error', stage: 'Missing video link', error: 'Paste a valid YouTube, Twitch or Kick video link.' });
      return;
    }
    update({ status: 'running', stage: 'Downloading video', progress: 0.05 });
    const dl = await downloadVideoUrl({
      url: linkUrl,
      outDir: job.dir,
      quality: Number(job.options.quality) || 720,
      rangeStart: job.options.range_start != null ? Number(job.options.range_start) : null,
      rangeEnd: job.options.range_end != null ? Number(job.options.range_end) : null,
      lang: job.lang,
      onProgress: (frac, stage) => {
        update({
          stage,
          progress: Number((0.05 + frac * 0.2).toFixed(3)),
        });
      },
    });
    job.source_path = dl.videoPath;
    job.source.path = dl.videoPath;
    downloadedSubtitles = dl.subtitles;
    if (dl.title && (!job.title || job.title === linkUrl || job.title === 'Untitled video')) {
      job.title = dl.title;
    }
    if (dl.uploader && !job.uploader) {
      job.uploader = dl.uploader;
    }
    update({ stage: 'Inspecting downloaded video', progress: 0.26 });
  } else {
    update({ status: 'running', stage: 'Inspecting video', progress: 0.08 });
  }

  const srcPath = job.source_path || job.source.path;
  if (!srcPath || !fs.existsSync(srcPath)) {
    update({ status: 'error', stage: 'Missing source file', error: 'Video file could not be found.' });
    return;
  }

  const probe = await probeVideo(srcPath);
  const thumbPath = path.join(job.dir, 'clips', 'thumb.jpg');
  const hasThumb = await extractThumbnail(srcPath, thumbPath, Math.min(2, probe.duration / 3));

  const creatorObj = job.creator ? getCreator(job.user, job.creator) : null;
  const [detectedGame] = detectGame(creatorObj?.game, job.title, job.uploader);

  update({
    width: probe.width,
    height: probe.height,
    duration: Number(probe.duration.toFixed(2)),
    has_audio: probe.hasAudio,
    thumb: hasThumb,
    game: creatorObj?.game || detectedGame,
    stage: 'Extracting audio & loudness',
    progress: 0.3,
  });

  const audioPath = path.join(job.dir, 'audio.mp3');
  const { audioReady, loudness } = probe.hasAudio
    ? await extractAudioAndLoudness(srcPath, audioPath, probe.duration)
    : { audioReady: false, loudness: Array.from({ length: Math.max(1, Math.ceil(probe.duration)) }, () => -24) };

  let words: WordStamp[] = [];
  let transcriptSource: 'subtitles' | 'gemini' | 'none' = 'none';
  const filteredSubs = downloadedSubtitles.filter((w) => w.s <= probe.duration + 0.5);

  if (isSubtitleCoverageAdequate(filteredSubs, probe.duration)) {
    words = filteredSubs;
    transcriptSource = 'subtitles';
  }

  if (words.length === 0 && audioReady) {
    update({ stage: 'Transcribing full video…', progress: 0.36 });
    try {
      words = await transcribeAudioWithGemini({
        audioPath,
        duration: probe.duration,
        lang: job.lang,
        uid: job.user,
        creator: job.creator,
        place: job.title,
        onProgress: (done, total) => {
          const frac = done / Math.max(1, total);
          update({
            stage: total > 1 ? `Transcribing full video (part ${done} of ${total})` : 'Transcribing full video…',
            progress: Number((0.36 + frac * 0.1).toFixed(3)),
          });
        },
      });
      if (words.length > 0) transcriptSource = 'gemini';
    } catch (err) {
      job.ai.note = `Transcription note: ${err instanceof Error ? err.message : String(err)}`.slice(0, 220);
    }
  }

  if (words.length === 0 && filteredSubs.length > 0) {
    words = filteredSubs;
    transcriptSource = 'subtitles';
  }
  writeWords(job, words);

  const coveragePct =
    words.length >= 2 && probe.duration > 0
      ? Math.min(100, Math.round(((Math.min(probe.duration, words[words.length - 1].e) - Math.max(0, words[0].s)) / probe.duration) * 100))
      : words.length > 0
        ? 100
        : 0;
  job.transcript_info = {
    words: words.length,
    coverage_pct: Math.max(0, coveragePct),
    source: transcriptSource,
  };

  update({ stage: 'Detecting facecam & framing…', progress: 0.48 });
  let framing: VideoFramingAnalysis | null = null;
  try {
    framing = await analyzeVideoFraming({
      videoPath: srcPath,
      duration: probe.duration,
      srcW: probe.width,
      srcH: probe.height,
      uid: job.user,
      creator: job.creator,
      place: job.title,
    });
  } catch {
    framing = null;
  }

  if (framing) {
    job.source_facecam = framing.sourceFacecam;
    job.video_type = framing.videoType;
    job.recommended_layout = framing.recommendedLayout;
    job.framing_summary = framing.summary;
    job.primary_subject_x = framing.primarySubjectX;
  } else {
    job.source_facecam = null;
    job.video_type = 'general';
    job.recommended_layout = 'track';
    job.framing_summary = '';
    job.primary_subject_x = 0.5;
  }

  update({ stage: 'Finding top moments across full transcript…', progress: 0.54 });
  const maxClips = Number(job.options.max_clips) || 6;
  const minLen = Number(job.options.min_len) || 15;
  const maxLen = Number(job.options.max_len) || 60;
  const style = String(job.options.style || 'bounce');
  const layout = String(job.options.layout || 'smart');
  const captions = job.options.captions !== false;
  const fixedHook = String(job.options.hook_text || '');
  const fixedDesc = String(job.options.description_text || '');

  const scout = await findClipsWithAi({
    words,
    loudness,
    duration: probe.duration,
    title: job.title,
    uploader: job.uploader,
    maxClips,
    minLen,
    maxLen,
    game: job.game,
    uid: job.user,
    creator: job.creator,
    onProgress: (done, total) => {
      if (total > 1) {
        update({
          stage: `Scouting top moments (part ${done} of ${total})`,
          progress: Number((0.54 + (done / total) * 0.08).toFixed(3)),
        });
      }
    },
  });

  job.ai = {
    model: scout.model,
    tokens: scout.tokens,
    note: scout.note || job.ai.note || '',
  };

  const resolvedDefaultLayout = resolveEffectiveLayout(layout, framing, Boolean(creatorObj?.facecam));

  job.clips = scout.clips.map((cand, idx) => {
    const cid = `clip${String(idx + 1).padStart(2, '0')}`;
    const excerpt = words
      .filter((w) => w.s >= cand.start - 0.3 && w.s <= cand.end + 0.3)
      .map((w) => w.w)
      .join(' ')
      .slice(0, 260);
    const clip: ClipRecord = {
      id: cid,
      start: cand.start,
      end: cand.end,
      score: cand.score,
      category: cand.category,
      hook: fixedHook || cand.hook,
      title: cand.title || `${job.title} #${idx + 1}`,
      description: fixedDesc || cand.description,
      fixed_description: Boolean(fixedDesc),
      hashtags: cand.hashtags,
      highlight_words: cand.highlight_words,
      reason: cand.reason,
      style,
      layout,
      resolved_layout: resolvedDefaultLayout,
      captions,
      status: 'queued',
      version: 0,
      error: null,
      facecam: creatorObj?.facecam ? { ...creatorObj.facecam } : null,
      source_facecam: job.source_facecam ?? null,
      track_points: null,
      spoken_excerpt: excerpt,
      split_ratio: normalizeSplitRatio(job.options.split_ratio ?? creatorObj?.split_ratio ?? DEFAULT_SPLIT_RATIO),
    };
    return applyHashtags(clip, words, job.title, job.uploader, job.game ?? null);
  });

  update({ stage: `Tracking & rendering ${job.clips.length} clip${job.clips.length === 1 ? '' : 's'}`, progress: 0.64 });

  for (let i = 0; i < job.clips.length; i++) {
    const clip = job.clips[i];
    update({
      stage:
        clip.resolved_layout === 'track'
          ? `Tracking person & rendering clip ${i + 1} of ${job.clips.length}`
          : `Rendering clip ${i + 1} of ${job.clips.length}`,
      progress: Number((0.64 + (i / Math.max(1, job.clips.length)) * 0.33).toFixed(3)),
    });
    await renderSingleClip(job, clip, words);
    update({
      stage: `Rendered ${i + 1} of ${job.clips.length} clips`,
      progress: Number((0.64 + ((i + 1) / Math.max(1, job.clips.length)) * 0.34).toFixed(3)),
    });
  }

  const okCount = job.clips.filter((c) => c.status === 'done').length;
  update({
    status: 'done',
    stage: okCount > 0 ? `Done — ${okCount} clip${okCount === 1 ? '' : 's'} ready` : 'Done',
    progress: 1,
  });

  addNotice(
    job.user,
    'job',
    `${job.title} finished`,
    `${okCount} clip${okCount === 1 ? '' : 's'} ready to review and download.`,
    `/app/videos`,
    `job:${job.id}`,
  );
}

export async function renderSingleClip(job: JobRecord, clip: ClipRecord, wordsOverride?: WordStamp[]): Promise<void> {
  clip.status = 'rendering';
  clip.error = null;
  bump(job.user);

  try {
    const src = clip.src || job.source_path || job.source.path;
    if (!src || !fs.existsSync(src)) {
      throw new Error('The original video file is no longer available.');
    }
    const words = wordsOverride ?? readWords(job);
    const creatorObj = job.creator ? getCreator(job.user, job.creator) : null;
    const effectiveFacecam = clip.facecam ?? creatorObj?.facecam ?? null;
    const effectiveSplitRatio = normalizeSplitRatio(clip.split_ratio ?? creatorObj?.split_ratio ?? DEFAULT_SPLIT_RATIO);

    // Lazily run visual framing detection on older jobs when user re-renders with smart/facecam/track layouts
    const needsVisualInfo =
      clip.layout === 'smart' ||
      clip.layout === 'track' ||
      clip.layout === 'split_gameplay' ||
      clip.layout === 'gameplay';
    if (needsVisualInfo && job.source_facecam === undefined && (job.width || 1280) > (job.height || 720)) {
      const framing = await analyzeVideoFraming({
        videoPath: src,
        duration: job.duration || clip.end || 30,
        srcW: job.width || 1280,
        srcH: job.height || 720,
        uid: job.user,
        creator: job.creator,
        place: job.title,
      });
      if (framing) {
        job.source_facecam = framing.sourceFacecam;
        job.video_type = framing.videoType;
        job.recommended_layout = framing.recommendedLayout;
        job.framing_summary = framing.summary;
        job.primary_subject_x = framing.primarySubjectX;
      } else {
        job.source_facecam = null;
      }
    }

    const framingSnapshot: VideoFramingAnalysis | null =
      job.video_type || job.source_facecam
        ? {
            videoType:
              job.video_type === 'gaming_facecam' ||
              job.video_type === 'talking_head' ||
              job.video_type === 'podcast_two_person'
                ? job.video_type
                : 'general',
            hasFacecam: Boolean(job.source_facecam),
            sourceFacecam: job.source_facecam ?? null,
            primarySubjectX: job.primary_subject_x ?? 0.5,
            recommendedLayout:
              job.recommended_layout === 'split_gameplay' ||
              job.recommended_layout === 'gameplay' ||
              job.recommended_layout === 'split'
                ? job.recommended_layout
                : 'track',
            confidence: 0.8,
            summary: job.framing_summary || '',
          }
        : null;

    const resolvedLayout = resolveEffectiveLayout(clip.layout, framingSnapshot, Boolean(creatorObj?.facecam));
    const clipEnd = Math.min(clip.end, job.duration || clip.end);

    // Run person tracking across this clip when using track layout on widescreen video
    if (resolvedLayout === 'track' && (job.width || 1280) > (job.height || 720) && (!clip.track_points || clip.track_points.length === 0)) {
      clip.track_points = await trackClipPerson({
        videoPath: src,
        clipStart: clip.start,
        clipEnd,
        fallbackSubjectX: job.primary_subject_x ?? 0.5,
        uid: job.user,
        creator: job.creator,
        place: clip.title || job.title,
      });
    }

    const effectiveSourceFacecam = clip.source_facecam ?? job.source_facecam ?? null;
    clip.source_facecam = effectiveSourceFacecam;
    clip.spoken_excerpt = words
      .filter((w) => w.s >= clip.start - 0.3 && w.s <= clipEnd + 0.3)
      .map((w) => w.w)
      .join(' ')
      .slice(0, 260);

    const out = await renderClip({
      src,
      outDir: path.join(job.dir, 'clips'),
      name: clip.id,
      start: clip.start,
      end: clipEnd,
      layout: resolvedLayout,
      style: clip.style,
      hook: clip.hook,
      captions: clip.captions,
      highlightWords: clip.highlight_words,
      words,
      srcW: job.width || 1280,
      srcH: job.height || 720,
      hasAudio: job.has_audio,
      facecam: effectiveFacecam,
      sourceFacecam: effectiveSourceFacecam,
      trackPoints: clip.track_points ?? null,
      splitRatio: effectiveSplitRatio,
      meta: { title: clip.title, description: clip.description },
    });

    clip.file = out.file;
    clip.cover = out.cover;
    clip.resolved_layout = out.layout;
    if (clip.layout !== 'smart') {
      clip.layout = out.layout;
    }
    clip.status = 'done';
    clip.version = (clip.version || 0) + 1;
    clip.made_at = clip.made_at || Date.now() / 1000;
    clip.error = null;

    fs.writeFileSync(
      path.join(job.dir, 'clips', `${clip.id}.json`),
      JSON.stringify(
        {
          title: clip.title,
          description: clip.description,
          hashtags: clip.hashtags,
          hook: clip.hook,
          start: clip.start,
          end: clip.end,
          score: clip.score,
          layout: clip.layout,
          resolved_layout: clip.resolved_layout,
        },
        null,
        2,
      ),
      'utf-8',
    );

    if (clip.version === 1) {
      addCreatorLog(job.creator, `Clip ready (score ${clip.score}): ${clip.title || clip.hook}`);
    }
  } catch (err) {
    clip.status = 'error';
    clip.error = err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
    addCreatorLog(job.creator, `Clip failed: ${clip.error.slice(0, 200)}`);
  }

  bump(job.user);
}

export function requestClipRerender(job: JobRecord, clip: ClipRecord, changes: Record<string, unknown>): void {
  const next = { ...clip };
  let timeChanged = false;
  if ('captions' in changes) {
    if (typeof changes.captions !== 'boolean') throw new Error('Captions must be on or off.');
    next.captions = changes.captions;
  }
  if ('start' in changes) {
    const val = Number(Number(changes.start).toFixed(2));
    if (val !== clip.start) timeChanged = true;
    next.start = val;
  }
  if ('end' in changes) {
    const val = Number(Number(changes.end).toFixed(2));
    if (val !== clip.end) timeChanged = true;
    next.end = val;
  }
  if (!Number.isFinite(next.start) || !Number.isFinite(next.end) || next.start < 0) {
    throw new Error("Those times aren't valid.");
  }
  if (next.end - next.start < 3 || next.end - next.start > 180) {
    throw new Error('A clip can be 3 to 180 seconds long.');
  }
  if (timeChanged) {
    next.track_points = null;
  }
  if ('hook' in changes) next.hook = cleanHook(changes.hook);
  if ('title' in changes) next.title = String(changes.title || '').slice(0, 100);
  if ('description' in changes) next.description = String(changes.description || '').slice(0, 2000);
  if ('style' in changes && typeof changes.style === 'string' && changes.style in STYLES) next.style = changes.style;
  if ('layout' in changes && typeof changes.layout === 'string' && changes.layout in LAYOUTS) next.layout = changes.layout;
  if ('hashtags' in changes) next.hashtags = cleanHashtags(changes.hashtags);
  if ('facecam' in changes) {
    if (changes.facecam === null) {
      next.facecam = null;
    } else {
      const norm = normalizeFacecam(changes.facecam);
      if (!norm) throw new Error('Facecam coordinates are not valid.');
      next.facecam = norm;
    }
  }
  if ('split_ratio' in changes && changes.split_ratio !== null && changes.split_ratio !== undefined) {
    const n = Number(changes.split_ratio);
    if (!Number.isFinite(n)) throw new Error('Splitscreen facecam height is not valid.');
    next.split_ratio = normalizeSplitRatio(n);
  }

  Object.assign(clip, next);
  clip.status = 'queued';
  bump(job.user);

  setImmediate(() => {
    void renderSingleClip(job, clip);
  });
}

export function savePostText(job: JobRecord, clip: ClipRecord, changes: Record<string, unknown>): void {
  if ('title' in changes) clip.title = String(changes.title || '').slice(0, 100);
  if ('description' in changes) clip.description = String(changes.description || '').slice(0, 2000);
  if ('hashtags' in changes) clip.hashtags = cleanHashtags(changes.hashtags);

  if (clip.hashtags_in_description && !clip.fixed_description && ('description' in changes || 'hashtags' in changes)) {
    const desc = String(clip.description || '').replace(TAG_IN_TEXT, '').trim();
    const line = (clip.hashtags || []).map((t) => `#${t}`).join(' ');
    clip.description = (desc && line ? `${desc}\n\n${line}` : desc || line).slice(0, 2000);
  }

  bump(job.user);
}

export function deleteJob(uid: string, jid: string): boolean {
  const job = getJob(uid, jid);
  if (!job) return false;
  if (job.status === 'queued' || job.status === 'running' || job.status === 'live') {
    throw new Error('This is still being worked on. Stop it or wait for it to finish first.');
  }
  delete getState().jobs[jid];
  fs.rmSync(job.dir, { recursive: true, force: true });
  bump(uid);
  return true;
}

export function deleteClip(uid: string, jid: string, cid: string): boolean {
  const job = getJob(uid, jid);
  if (!job) return false;
  const idx = job.clips.findIndex((c) => c.id === cid);
  if (idx === -1) return false;
  const clip = job.clips[idx];
  if (clip.status === 'queued' || clip.status === 'rendering') {
    throw new Error('This clip is still being made.');
  }
  for (const ext of ['mp4', 'jpg', 'ass', 'json']) {
    fs.rmSync(path.join(job.dir, 'clips', `${clip.id}.${ext}`), { force: true });
  }
  job.clips.splice(idx, 1);
  bump(uid);
  return true;
}

export function startLiveSession(uid: string, cid: string, channelUrl?: string): JobRecord {
  const c = getCreator(uid, cid);
  if (!c) throw new Error('No such creator');
  const existing = Object.values(getState().jobs).find(
    (j) => j.user === uid && j.creator === cid && j.kind === 'live' && j.status === 'live',
  );
  if (existing) return existing;

  const url = channelUrl || c.channel || Object.values(c.channels)[0] || '';
  if (!url) throw new Error('Add a YouTube, Twitch or Kick channel link in Setup first.');

  const job = createJob({
    uid,
    source: { type: 'live', name: `${c.name} — Live`, url },
    creator: cid,
    kind: 'live',
  });
  job.title = `${c.name} — Live stream`;
  job.stage = 'Watching stream (upload a VOD or use Clip Now)';
  addCreatorLog(cid, `Started live recording session on ${url}`);
  bump(uid);
  return job;
}

export function stopLiveSession(uid: string, jid: string): boolean {
  const job = getJob(uid, jid);
  if (!job || job.kind !== 'live') return false;
  job.status = 'done';
  job.stage = 'Recording ended';
  addCreatorLog(job.creator, 'Stopped live recording');
  bump(uid);
  return true;
}
