import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import * as config from './config.ts';
import type { WordStamp } from './hashtags.ts';

const execFileAsync = promisify(execFile);

const YTDLP_ZIPAPP_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
const YTDLP_LINUX_BIN_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';

let cachedYtDlpPath: string | null = null;
let bootstrapPromise: Promise<string> | null = null;

export interface YtDlpMetadata {
  title: string;
  uploader: string;
  duration: number;
  thumb: string;
  live: boolean;
  url: string;
}

export interface DownloadVideoOptions {
  url: string;
  outDir: string;
  quality?: number;
  rangeStart?: number | null;
  rangeEnd?: number | null;
  lang?: string;
  onProgress?: (fraction: number, stage: string) => void;
}

export interface DownloadVideoResult {
  videoPath: string;
  title?: string;
  uploader?: string;
  duration?: number;
  subtitles: WordStamp[];
}

export function isYouTubeUrl(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

export function isTwitchUrl(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'twitch.tv' || h.endsWith('.twitch.tv');
  } catch {
    return false;
  }
}

export function isKickUrl(rawUrl: string): boolean {
  try {
    const h = new URL(rawUrl).hostname.toLowerCase();
    return h === 'kick.com' || h.endsWith('.kick.com');
  } catch {
    return false;
  }
}

export function formatSectionTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function parseYtDlpProgressLine(line: string): number | null {
  const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/i);
  if (m) {
    const pct = Number(m[1]);
    if (Number.isFinite(pct)) return Math.max(0, Math.min(1, pct / 100));
  }
  return null;
}

export function parseJson3Subtitles(jsonText: string, offsetSeconds = 0): WordStamp[] {
  let parsed: {
    events?: Array<{
      tStartMs?: number;
      dDurationMs?: number;
      segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
    }>;
  };
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  const words: WordStamp[] = [];

  for (const ev of events) {
    const baseMs = Number(ev.tStartMs);
    if (!Number.isFinite(baseMs) || !Array.isArray(ev.segs)) continue;
    const evDurMs = Math.max(200, Number(ev.dDurationMs) || 1200);
    const segs = ev.segs;

    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const raw = String(seg.utf8 || '')
        .replace(/\n+/g, ' ')
        .trim();
      if (!raw || raw === '♪' || raw === '[Music]') continue;
      const segOffset = Number.isFinite(Number(seg.tOffsetMs)) ? Number(seg.tOffsetMs) : 0;
      const startMs = baseMs + segOffset;
      let nextMs = baseMs + evDurMs;
      for (let j = i + 1; j < segs.length; j++) {
        if (Number.isFinite(Number(segs[j].tOffsetMs))) {
          nextMs = baseMs + Number(segs[j].tOffsetMs);
          break;
        }
      }
      const tokens = raw.split(/\s+/).filter(Boolean);
      const spanMs = Math.max(120, nextMs - startMs);
      const perToken = spanMs / Math.max(1, tokens.length);
      for (let t = 0; t < tokens.length; t++) {
        const s = (startMs + t * perToken) / 1000 - offsetSeconds;
        const e = (startMs + (t + 1) * perToken) / 1000 - offsetSeconds;
        if (e <= 0) continue;
        words.push({
          w: tokens[t],
          s: Number(Math.max(0, s).toFixed(3)),
          e: Number(Math.max(Math.max(0, s) + 0.08, e).toFixed(3)),
        });
      }
    }
  }

  return words.sort((a, b) => a.s - b.s);
}

export function explainDownloadError(stderr: string, url: string, hasCookies: boolean): string {
  const low = stderr.toLowerCase();
  if (low.includes('sign in to confirm') || low.includes('not a bot') || low.includes('login_required')) {
    if (hasCookies) {
      return "YouTube isn't letting PeakCut download with the saved cookies (they may have expired). Replace YouTube cookies in Settings → Connected apps → YouTube links, or upload the video file directly.";
    }
    return "YouTube isn't letting PeakCut download this video without sign-in on this server. Add YouTube cookies in Settings → Connected apps → YouTube links, or upload the video file directly.";
  }
  if (low.includes('private video') || low.includes('members-only') || low.includes('sign in if you')) {
    return 'That video is private or restricted. Add YouTube cookies in Settings → Connected apps if you have access, or try a public link.';
  }
  if (low.includes('video unavailable') || low.includes('does not exist') || low.includes('no longer available') || low.includes('http error 404')) {
    return 'That video could not be found — it may have been removed or the link may be expired.';
  }
  if (low.includes('is live') || low.includes('live event will begin')) {
    return 'That link is currently live or scheduled. Wait until the stream finishes, or upload a recorded clip.';
  }
  if (low.includes('403') && isKickUrl(url)) {
    return 'Kick blocked this server download request (Cloudflare challenge). Try downloading locally and uploading the video file directly.';
  }
  if (low.includes('file is larger than max-filesize')) {
    return 'That video is larger than the 4 GB server download limit. Set a shorter "From / To" time range in Options to download just the part you want.';
  }
  const errLine = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .pop();
  if (errLine) {
    return errLine.replace(/^ERROR:\s*(\[[^\]]+\]\s*[\w-]+:\s*)?/i, '').slice(0, 260);
  }
  return 'Could not download that video link. Check that the link is public, or upload the video file directly.';
}

async function isRunnableBinary(binPath: string): Promise<boolean> {
  try {
    await execFileAsync(binPath, ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function hasPython3(): Promise<boolean> {
  try {
    await execFileAsync('python3', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function downloadFileTo(url: string, destPath: string): Promise<void> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
    headers: { 'User-Agent': 'PeakCut-Downloader/1.0' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} downloading yt-dlp`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500_000) {
    throw new Error('Downloaded yt-dlp binary was unexpectedly small');
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, destPath);
}

export async function ensureYtDlp(): Promise<string> {
  if (cachedYtDlpPath && fs.existsSync(cachedYtDlpPath)) {
    return cachedYtDlpPath;
  }
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const candidates = [
      process.env.YTDLP_PATH?.trim() || '',
      'yt-dlp',
      path.join(config.ROOT, 'bin', 'yt-dlp'),
      path.join(config.DATA_DIR, 'bin', 'yt-dlp'),
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (candidate !== 'yt-dlp' && !fs.existsSync(candidate)) continue;
      if (await isRunnableBinary(candidate)) {
        cachedYtDlpPath = candidate;
        return candidate;
      }
    }

    const target = path.join(config.DATA_DIR, 'bin', 'yt-dlp');
    const useZipapp = await hasPython3();
    const primaryUrl = useZipapp ? YTDLP_ZIPAPP_URL : YTDLP_LINUX_BIN_URL;
    const fallbackUrl = useZipapp ? YTDLP_LINUX_BIN_URL : YTDLP_ZIPAPP_URL;

    try {
      await downloadFileTo(primaryUrl, target);
      if (await isRunnableBinary(target)) {
        cachedYtDlpPath = target;
        return target;
      }
    } catch {
      // try fallback
    }

    await downloadFileTo(fallbackUrl, target);
    if (!(await isRunnableBinary(target))) {
      throw new Error('Could not initialize yt-dlp downloader binary');
    }
    cachedYtDlpPath = target;
    return target;
  })().finally(() => {
    bootstrapPromise = null;
  });

  return bootstrapPromise;
}

function activeCookiesPath(): string | null {
  const envFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (envFile && fs.existsSync(envFile)) return envFile;
  if (fs.existsSync(config.YT_COOKIES)) return config.YT_COOKIES;
  return null;
}

function commonArgs(url: string, extraExtractorArgs?: string): string[] {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--force-ipv4',
    '--js-runtimes',
    'node',
    '--remote-components',
    'ejs:github',
  ];
  const cookies = activeCookiesPath();
  if (cookies) {
    args.push('--cookies', cookies);
  }
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) {
    args.push('--proxy', proxy);
  }
  if (extraExtractorArgs && isYouTubeUrl(url)) {
    args.push('--extractor-args', extraExtractorArgs);
  }
  return args;
}

export async function probeLinkWithYtDlp(url: string): Promise<YtDlpMetadata | null> {
  let bin: string;
  try {
    bin = await ensureYtDlp();
  } catch {
    return null;
  }

  const strategies: Array<string | undefined> = isYouTubeUrl(url)
    ? [undefined, 'youtube:player_client=tv_embedded,mweb']
    : [undefined];

  for (const strat of strategies) {
    try {
      const args = [...commonArgs(url, strat), '--dump-single-json', '--skip-download', '--', url];
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 20_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const data = JSON.parse(stdout) as {
        title?: string;
        uploader?: string;
        channel?: string;
        duration?: number;
        thumbnail?: string;
        is_live?: boolean;
        live_status?: string;
      };
      if (data && (data.title || data.duration)) {
        return {
          title: String(data.title || 'Untitled video').slice(0, 140),
          uploader: String(data.uploader || data.channel || '').slice(0, 80),
          duration: Math.max(0, Number(data.duration) || 0),
          thumb: String(data.thumbnail || ''),
          live: Boolean(data.is_live || data.live_status === 'is_live'),
          url,
        };
      }
    } catch {
      // try next strategy
    }
  }
  return null;
}

function runYtDlpProcess(
  bin: string,
  args: string[],
  onProgress?: (fraction: number, stage: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let lastReport = 0;

    const handleChunk = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString('utf-8');
      if (isErr) stderr += text;
      else stdout += text;

      if (onProgress) {
        for (const line of text.split(/\r?\n/)) {
          const frac = parseYtDlpProgressLine(line);
          if (frac !== null) {
            const now = Date.now();
            if (now - lastReport > 350 || frac >= 0.99) {
              lastReport = now;
              onProgress(frac, `Downloading video (${Math.round(frac * 100)}%)`);
            }
          }
        }
      }
    };

    child.stdout.on('data', (c: Buffer) => handleChunk(c, false));
    child.stderr.on('data', (c: Buffer) => handleChunk(c, true));

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, 10 * 60_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}\n${err.message}` });
    });
  });
}

function findDownloadedVideo(outDir: string): string | null {
  const entries = fs.readdirSync(outDir);
  const videoExts = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v']);
  const candidates = entries
    .filter((f) => f.startsWith('source.') && videoExts.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(outDir, f))
    .filter((fp) => fs.existsSync(fp) && fs.statSync(fp).size > 10_000)
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return candidates[0] || null;
}

function loadDownloadedSubtitles(outDir: string, offsetSeconds: number): WordStamp[] {
  try {
    const entries = fs.readdirSync(outDir);
    const subFile = entries.find((f) => f.startsWith('source.') && f.endsWith('.json3'));
    if (!subFile) return [];
    const text = fs.readFileSync(path.join(outDir, subFile), 'utf-8');
    return parseJson3Subtitles(text, offsetSeconds);
  } catch {
    return [];
  }
}

function cleanupPartialDownloads(outDir: string): void {
  try {
    for (const f of fs.readdirSync(outDir)) {
      if (f.startsWith('source.')) {
        fs.rmSync(path.join(outDir, f), { force: true });
      }
    }
  } catch {
    // ignore
  }
}

async function fetchOptionalSubtitles(opts: {
  bin: string;
  url: string;
  outDir: string;
  lang?: string;
  startSec: number;
  cookiesPath: string | null;
}): Promise<WordStamp[]> {
  if (!isYouTubeUrl(opts.url)) return [];
  const langCode = opts.lang === 'ar' ? 'ar,en' : 'en,hi';
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--force-ipv4',
    '--js-runtimes',
    'node',
    '--remote-components',
    'ejs:github',
    '--skip-download',
    '--ignore-errors',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    langCode,
    '--sub-format',
    'json3',
    '-o',
    path.join(opts.outDir, 'source.%(ext)s'),
  ];
  if (opts.cookiesPath) args.push('--cookies', opts.cookiesPath);
  const proxy = process.env.YTDLP_PROXY?.trim();
  if (proxy) args.push('--proxy', proxy);
  args.push('--', opts.url);

  try {
    await execFileAsync(opts.bin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    // Subtitles are strictly optional — ignore 429 or missing captions.
  }
  return loadDownloadedSubtitles(opts.outDir, opts.startSec);
}

export async function downloadVideoUrl(opts: DownloadVideoOptions): Promise<DownloadVideoResult> {
  opts.onProgress?.(0.02, 'Preparing downloader');
  const bin = await ensureYtDlp();
  fs.mkdirSync(opts.outDir, { recursive: true });

  const quality = Math.max(360, Math.min(1080, Math.round(opts.quality || 720)));
  const outTemplate = path.join(opts.outDir, 'source.%(ext)s');
  const hasRange = opts.rangeStart != null || opts.rangeEnd != null;
  const startSec = opts.rangeStart != null ? Math.max(0, opts.rangeStart) : 0;
  const endSec = opts.rangeEnd != null && opts.rangeEnd > startSec ? opts.rangeEnd : null;
  const srcCookies = activeCookiesPath();
  const cookiesSaved = Boolean(srcCookies);

  // Copy cookies to an isolated temp file so yt-dlp's cookie writeback never corrupts the saved file
  let tempCookies: string | null = null;
  if (srcCookies) {
    try {
      tempCookies = path.join(opts.outDir, '.cookies.tmp');
      fs.copyFileSync(srcCookies, tempCookies);
    } catch {
      tempCookies = srcCookies;
    }
  }

  const formatSpecPrimary =
    `bestvideo[height<=${quality}][fps<=30][ext=mp4]+bestaudio[format_note*=original][ext=m4a]/` +
    `bestvideo[height<=${quality}][ext=mp4]+bestaudio[format_note*=original][ext=m4a]/` +
    `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${quality}]+bestaudio[format_note*=original]/` +
    `bestvideo[height<=${quality}]+bestaudio/` +
    `best[height<=${quality}]/best`;
  const formatSpecFallback = `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`;

  const strategies: Array<{ label: string; extractorArgs?: string; format: string }> = isYouTubeUrl(opts.url)
    ? [
        { label: 'default', format: formatSpecPrimary },
        { label: 'default-any-format', format: formatSpecFallback },
        { label: 'mweb', extractorArgs: 'youtube:player_client=tv_embedded,mweb', format: formatSpecFallback },
        { label: 'android_vr', extractorArgs: 'youtube:player_client=android_vr,ios', format: formatSpecFallback },
      ]
    : [
        { label: 'default', format: formatSpecPrimary },
        { label: 'default-any-format', format: formatSpecFallback },
      ];

  let lastStderr = '';

  try {
    for (let i = 0; i < strategies.length; i++) {
      const strat = strategies[i];
      cleanupPartialDownloads(opts.outDir);

      const args = [
        '--no-playlist',
        '--no-warnings',
        '--force-ipv4',
        '--js-runtimes',
        'node',
        '--remote-components',
        'ejs:github',
        '--newline',
        '--progress',
        '--no-part',
        '--max-filesize',
        '4000M',
        '-f',
        strat.format,
        '--merge-output-format',
        'mp4',
        '-o',
        outTemplate,
      ];

      if (tempCookies) {
        args.push('--cookies', tempCookies);
      }
      const proxy = process.env.YTDLP_PROXY?.trim();
      if (proxy) {
        args.push('--proxy', proxy);
      }
      if (strat.extractorArgs && isYouTubeUrl(opts.url)) {
        args.push('--extractor-args', strat.extractorArgs);
      }

      if (hasRange) {
        const section = `*${formatSectionTime(startSec)}-${endSec !== null ? formatSectionTime(endSec) : 'inf'}`;
        args.push('--download-sections', section);
      }

      args.push('--print-json', '--', opts.url);

      opts.onProgress?.(0.05, i === 0 ? 'Downloading video' : 'Retrying video download');
      const res = await runYtDlpProcess(bin, args, opts.onProgress);
      if (res.stderr || res.stdout) {
        lastStderr = res.stderr || res.stdout;
      }

      const downloaded = findDownloadedVideo(opts.outDir);
      if (res.code === 0 && downloaded) {
        let title: string | undefined;
        let uploader: string | undefined;
        let duration: number | undefined;
        for (const line of res.stdout.split(/\r?\n/).reverse()) {
          const trimmed = line.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              const meta = JSON.parse(trimmed) as {
                title?: string;
                uploader?: string;
                channel?: string;
                duration?: number;
              };
              title = meta.title ? String(meta.title).slice(0, 140) : undefined;
              uploader =
                meta.uploader || meta.channel ? String(meta.uploader || meta.channel).slice(0, 80) : undefined;
              duration = Number.isFinite(Number(meta.duration)) ? Number(meta.duration) : undefined;
              break;
            } catch {
              // keep scanning
            }
          }
        }

        const subtitles = await fetchOptionalSubtitles({
          bin,
          url: opts.url,
          outDir: opts.outDir,
          lang: opts.lang,
          startSec,
          cookiesPath: tempCookies,
        });
        return { videoPath: downloaded, title, uploader, duration, subtitles };
      }

      // If the failure is clearly permanent (404 / private / too large), don't waste retries.
      const low = lastStderr.toLowerCase();
      if (
        low.includes('does not exist') ||
        low.includes('no longer available') ||
        low.includes('private video') ||
        low.includes('file is larger than max-filesize')
      ) {
        break;
      }
    }

    cleanupPartialDownloads(opts.outDir);
    throw new Error(explainDownloadError(lastStderr, opts.url, cookiesSaved));
  } finally {
    if (tempCookies && tempCookies !== srcCookies) {
      fs.rmSync(tempCookies, { force: true });
    }
  }
}
