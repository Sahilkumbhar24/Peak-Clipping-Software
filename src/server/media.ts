import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isTwitchUrl, isYouTubeUrl, probeLinkWithYtDlp } from './ytdlp.ts';

const execFileAsync = promisify(execFile);

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'twitch.tv',
  'www.twitch.tv',
  'm.twitch.tv',
  'clips.twitch.tv',
  'kick.com',
  'www.kick.com',
]);

export interface VideoProbe {
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
}

export function siteAllowed(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function normalizeChannelUrl(rawUrl: string): string {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  return s.includes('://') ? s : `https://${s}`;
}

export async function probeVideo(filePath: string): Promise<VideoProbe> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', filePath],
    { timeout: 30_000 },
  );
  const data = JSON.parse(stdout) as {
    streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
    format?: { duration?: string };
  };
  const vStream = (data.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (data.streams || []).find((s) => s.codec_type === 'audio');
  return {
    width: Number(vStream?.width) || 1280,
    height: Number(vStream?.height) || 720,
    duration: Math.max(1, Number(data.format?.duration) || 10),
    hasAudio: Boolean(aStream),
  };
}

export async function extractThumbnail(videoPath: string, outJpgPath: string, atSeconds = 1): Promise<boolean> {
  try {
    fs.mkdirSync(path.dirname(outJpgPath), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', videoPath, '-frames:v', '1', '-q:v', '4', outJpgPath],
      { timeout: 20_000 },
    );
    return fs.existsSync(outJpgPath);
  } catch {
    return false;
  }
}

export async function extractAudioAndLoudness(
  videoPath: string,
  outMp3Path: string,
  duration: number,
): Promise<{ audioReady: boolean; loudness: number[] }> {
  const loudness: number[] = [];
  let audioReady = false;

  try {
    fs.mkdirSync(path.dirname(outMp3Path), { recursive: true });
    await execFileAsync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '24k', outMp3Path],
      { timeout: 180_000 },
    );
    audioReady = fs.existsSync(outMp3Path) && fs.statSync(outMp3Path).size > 100;
  } catch {
    audioReady = false;
  }

  if (audioReady) {
    try {
      const { stdout } = await execFileAsync(
        'ffmpeg',
        ['-v', 'error', '-i', outMp3Path, '-f', 's16le', '-ac', '1', '-ar', '1000', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
      );
      const buf = stdout as unknown as Buffer;
      const samplesPerSec = 1000;
      const totalSamples = Math.floor(buf.length / 2);
      const seconds = Math.max(1, Math.ceil(totalSamples / samplesPerSec));
      for (let s = 0; s < seconds; s++) {
        const start = s * samplesPerSec;
        const end = Math.min(totalSamples, start + samplesPerSec);
        let sumSq = 0;
        for (let i = start; i < end; i++) {
          const val = buf.readInt16LE(i * 2) / 32768;
          sumSq += val * val;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, end - start));
        const db = 20 * Math.log10(Math.max(rms, 1e-5));
        loudness.push(db);
      }
    } catch {
      // fall through to flat curve
    }
  }

  if (loudness.length === 0) {
    const secs = Math.max(1, Math.ceil(duration));
    for (let i = 0; i < secs; i++) loudness.push(-24);
  }

  return { audioReady, loudness };
}

export interface SampledFrame {
  t: number;
  path: string;
}

/**
 * Extracts lightweight JPEG keyframes at the requested timestamps (in seconds)
 * for Gemini Vision framing detection and person tracking.
 */
export async function extractSampleFrames(
  videoPath: string,
  timestampsSec: number[],
  outDir: string,
  maxWidth = 640,
): Promise<SampledFrame[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const results: SampledFrame[] = [];
  for (let i = 0; i < timestampsSec.length; i++) {
    const t = Math.max(0, Number(timestampsSec[i]) || 0);
    const outPath = path.join(outDir, `f_${String(i).padStart(2, '0')}.jpg`);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-ss',
          t.toFixed(2),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${Math.max(160, Math.round(maxWidth))},iw)':-2`,
          '-q:v',
          '5',
          outPath,
        ],
        { timeout: 20_000 },
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 200) {
        results.push({ t: Number(t.toFixed(2)), path: outPath });
      }
    } catch {
      // skip individual frame failures cleanly
    }
  }
  return results;
}

export interface AudioChunk {
  index: number;
  start: number;
  duration: number;
  path: string;
}

/**
 * Splits a full-video MP3 track into bounded time-anchored chunks so videos of any length
 * (>18 MB or multi-hour streams) can be transcribed completely with accurate timestamps.
 */
export async function splitAudioChunks(
  audioPath: string,
  totalDuration: number,
  outDir: string,
  chunkSec = 240,
): Promise<AudioChunk[]> {
  const dur = Math.max(1, totalDuration);
  const segLen = Math.max(30, Math.min(360, Math.round(chunkSec)));
  if (dur <= segLen + 15) {
    const stat = fs.existsSync(audioPath) ? fs.statSync(audioPath) : null;
    if (stat && stat.size > 0 && stat.size <= 14 * 1024 * 1024) {
      return [{ index: 0, start: 0, duration: dur, path: audioPath }];
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const chunks: AudioChunk[] = [];
  let idx = 0;
  for (let start = 0; start < dur - 0.4; start += segLen) {
    const span = Math.min(segLen, dur - start);
    const chunkPath = path.join(outDir, `chunk_${String(idx).padStart(3, '0')}.mp3`);
    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-v',
          'error',
          '-ss',
          start.toFixed(2),
          '-t',
          span.toFixed(2),
          '-i',
          audioPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-b:a',
          '24k',
          chunkPath,
        ],
        { timeout: 60_000 },
      );
      if (fs.existsSync(chunkPath) && fs.statSync(chunkPath).size > 100) {
        chunks.push({
          index: idx,
          start: Number(start.toFixed(2)),
          duration: Number(span.toFixed(2)),
          path: chunkPath,
        });
      }
    } catch {
      // skip failed chunk and continue with remaining timeline
    }
    idx += 1;
  }
  return chunks;
}

export interface LinkPreview {
  title: string;
  uploader: string;
  duration: number;
  thumb: string;
  url: string;
  live?: boolean;
}

const previewCache = new Map<string, LinkPreview>();

export function getCachedPreview(url: string): LinkPreview | undefined {
  return previewCache.get(url);
}

async function fetchTwitchGraphqlPreview(url: string): Promise<LinkPreview | null> {
  try {
    const u = new URL(url);
    const vodMatch = u.pathname.match(/^\/videos\/(\d+)/);
    if (vodMatch) {
      const id = vodMatch[1];
      const res = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query { video(id: "${id}") { title lengthSeconds previewThumbnailURL(width: 640, height: 360) owner { displayName login } } }`,
        }),
        signal: AbortSignal.timeout(7000),
      });
      if (res.ok) {
        const payload = (await res.json()) as {
          data?: {
            video?: {
              title?: string;
              lengthSeconds?: number;
              previewThumbnailURL?: string;
              owner?: { displayName?: string; login?: string };
            };
          };
        };
        const v = payload.data?.video;
        if (v) {
          return {
            title: v.title || `Twitch VOD ${id}`,
            uploader: v.owner?.displayName || v.owner?.login || 'Twitch',
            duration: Number(v.lengthSeconds) || 0,
            thumb: v.previewThumbnailURL || '',
            url,
            live: false,
          };
        }
      }
    }
  } catch {
    // fall back to yt-dlp
  }
  return null;
}

export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview> {
  const url = normalizeChannelUrl(rawUrl);
  if (!siteAllowed(url)) {
    throw new Error('Paste a full link to a YouTube, Twitch or Kick video.');
  }
  const cached = previewCache.get(url);
  if (cached) return cached;

  const u = new URL(url);
  const host = u.hostname.toLowerCase();

  if (isTwitchUrl(url)) {
    const tw = await fetchTwitchGraphqlPreview(url);
    if (tw) {
      previewCache.set(url, tw);
      return tw;
    }
  }

  let fastInfo: LinkPreview | null = null;
  try {
    if (isYouTubeUrl(url)) {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const data = (await res.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
        fastInfo = {
          title: data.title || 'YouTube video',
          uploader: data.author_name || 'YouTube',
          duration: 0,
          thumb: data.thumbnail_url || '',
          url,
          live: false,
        };
      }
    }
  } catch {
    // fall through
  }

  // Enrich with yt-dlp metadata when fastInfo is missing or lacks duration
  if (!fastInfo || !fastInfo.duration) {
    const probed = await probeLinkWithYtDlp(url);
    if (probed) {
      const merged: LinkPreview = {
        title: probed.title || fastInfo?.title || 'Untitled video',
        uploader: probed.uploader || fastInfo?.uploader || host.replace(/^www\./, ''),
        duration: probed.duration || fastInfo?.duration || 0,
        thumb: probed.thumb || fastInfo?.thumb || '',
        url,
        live: probed.live,
      };
      previewCache.set(url, merged);
      return merged;
    }
  }

  if (fastInfo) {
    previewCache.set(url, fastInfo);
    return fastInfo;
  }

  const slug = u.pathname.replace(/^\/+|\/+$/g, '') || host;
  const info: LinkPreview = {
    title: slug.slice(0, 80),
    uploader: host.replace(/^www\./, ''),
    duration: 0,
    thumb: '',
    url,
    live: false,
  };
  previewCache.set(url, info);
  return info;
}

export async function fetchChannelPreview(rawUrl: string) {
  const url = normalizeChannelUrl(rawUrl);
  if (!siteAllowed(url)) {
    throw new Error('Paste a YouTube, Twitch or Kick channel link.');
  }
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const platform = host.includes('youtube') || host === 'youtu.be' ? 'youtube' : host.includes('twitch') ? 'twitch' : 'kick';
  const seg = u.pathname.split('/').filter(Boolean).pop() || host;
  const cleanName = seg.replace(/^@/, '');
  return {
    name: cleanName.charAt(0).toUpperCase() + cleanName.slice(1),
    channel: url,
    platform,
    live: false,
    title: '',
    pic: '',
  };
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
