import 'dotenv/config';
import { createRequire } from 'node:module';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';

const require = createRequire(import.meta.url);
interface ZipArchiveStream {
  pipe: (dest: Response) => void;
  file: (filePath: string, data: { name: string }) => void;
  finalize: () => Promise<void>;
  on: (event: string, listener: (err: Error) => void) => void;
}
type ArchiverFactory = (format: string, options?: { zlib?: { level?: number } }) => ZipArchiveStream;
type ArchiverModule =
  | {
      ZipArchive?: new (options?: { zlib?: { level?: number } }) => ZipArchiveStream;
      default?: ArchiverFactory;
    }
  | ArchiverFactory;

const archiverModule = require('archiver') as ArchiverModule;

function createZipArchive(options?: { zlib?: { level?: number } }): ZipArchiveStream {
  if (typeof archiverModule === 'function') {
    return archiverModule('zip', options);
  }
  if (typeof archiverModule.ZipArchive === 'function') {
    return new archiverModule.ZipArchive(options);
  }
  if (typeof archiverModule.default === 'function') {
    return archiverModule.default('zip', options);
  }
  throw new Error('ZIP archiver is unavailable');
}
import {
  currentAiConfig,
  explainAiError,
  getAiProviderLabel,
  isAiReady,
  listProviderModels,
  publicAiConfig,
  saveAiConfig,
  testAiConnection,
  usageBrief,
  usageSummary,
} from './src/server/ai.ts';
import { rewritePostText } from './src/server/brain.ts';
import * as config from './src/server/config.ts';
import {
  createCreator,
  creatorRows,
  deleteCreator,
  getCreator,
  listCreators,
  platformKey,
  updateCreator,
} from './src/server/creators.ts';
import {
  busyCount,
  cleanOptions,
  createJob,
  deleteClip,
  deleteJob,
  enqueueVideoJob,
  getJob,
  listJobs,
  publicJob,
  requestClipRerender,
  savePostText,
  spokenInClip,
  startLiveSession,
  stopLiveSession,
} from './src/server/jobs.ts';
import {
  checkFfmpegAvailable,
  fetchChannelPreview,
  fetchLinkPreview,
  normalizeChannelUrl,
  siteAllowed,
} from './src/server/media.ts';
import {
  alertsConfigured,
  appsPublic,
  canConnect,
  enqueuePosts,
  getOverview,
  listConnectedAccounts,
  PLATFORM_NAMES,
  postAction,
  removeConnectedAccount,
  saveAppKeys,
} from './src/server/posting.ts';
import { LAYOUTS, STYLES } from './src/server/render.ts';
import {
  addNotice,
  bump,
  getLocalUser,
  getSpeechBrief,
  getSpeechList,
  getState,
  getUnreadCount,
  getUserSettings,
  hashPassword,
  nextId,
  publicUser,
  publicUserSettings,
  SPEECH_MODELS_META,
  syncToken,
  type UserRecord,
  verifyPassword,
} from './src/server/store.ts';

config.ensureDirs();

const app = express();
app.disable('x-powered-by');
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);
const SESSION_COOKIE = 'peakcut_session';

const upload = multer({
  dest: path.join(config.TMP_DIR, 'uploads'),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024 },
});

let ffmpegAvailable = true;
void checkFfmpegAvailable().then((ok) => {
  ffmpegAvailable = ok;
});

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRecord;
  }
}

function getRequestUser(req: Request): UserRecord | null {
  if (!config.ACCOUNTS) {
    return getLocalUser();
  }
  const token = String(req.cookies?.[SESSION_COOKIE] || '');
  if (!token) return null;
  const st = getState();
  const sess = st.sessions[token];
  if (!sess || sess.expires_at < Date.now() / 1000) return null;
  const u = st.users[sess.user_id];
  if (!u || u.disabled) return null;
  return u;
}

app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  const u = getRequestUser(req);
  if (u) {
    u.last_seen = Date.now() / 1000;
    req.user = u;
  }
  next();
});

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.user) {
    res.status(401).json({ detail: 'Please sign in.' });
    return;
  }
  next();
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user || !req.user.is_admin || req.user.disabled) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  next();
}

function sendWebPage(res: Response, fileName: string, shared = false) {
  const filePath = path.join(config.WEB_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('Page not found');
    return;
  }
  res.setHeader('Cache-Control', `${shared ? 'public' : 'private'}, no-cache`);
  res.sendFile(filePath);
}

// ================================================================ Pages & Static Assets

app.get('/', (req, res) => {
  if (!config.ACCOUNTS) {
    res.redirect(303, '/app');
    return;
  }
  const html = fs.readFileSync(path.join(config.WEB_DIR, 'landing.html'), 'utf-8').replaceAll('{{SITE}}', config.PUBLIC_URL);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/landing', (_req, res) => {
  const html = fs.readFileSync(path.join(config.WEB_DIR, 'landing.html'), 'utf-8').replaceAll('{{SITE}}', config.PUBLIC_URL);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get(['/app', '/app/*'], (req, res) => {
  if (config.ACCOUNTS && !req.user) {
    res.redirect(303, '/login');
    return;
  }
  sendWebPage(res, 'index.html');
});

app.get(['/admin', '/admin/*'], requireAdmin, (_req, res) => {
  sendWebPage(res, 'admin.html');
});

app.get(['/login', '/signup'], (req, res) => {
  if (req.user) {
    res.redirect(303, '/app');
    return;
  }
  sendWebPage(res, 'auth.html', true);
});

app.get('/reset', (req, res) => {
  if (!config.ACCOUNTS) {
    res.redirect(303, '/app');
    return;
  }
  sendWebPage(res, 'reset.html', true);
});

const LEGAL_PAGES: Record<string, [string, string]> = {
  privacy: ['Privacy Policy', 'How PeakCut collects, uses and protects your data.'],
  terms: ['Terms of Service', 'The terms for using PeakCut, the AI clipping tool for streams and videos.'],
  'acceptable-use': ['Acceptable Use Policy', 'What you may and may not do with PeakCut.'],
};

app.get(['/privacy', '/terms', '/acceptable-use'], (req, res) => {
  const page = req.path.replace(/^\/+/, '');
  const [title, desc] = LEGAL_PAGES[page] || LEGAL_PAGES.terms;
  const who = config.CONTACT_EMAIL
    ? `<a href="mailto:${config.CONTACT_EMAIL}">${config.CONTACT_EMAIL}</a>`
    : 'the contact details on our website';
  const law = config.LEGAL_COUNTRY
    ? `the laws of ${config.LEGAL_COUNTRY}`
    : "the laws of the country where PeakCut's operator is established";
  let html = fs.readFileSync(path.join(config.WEB_DIR, 'legal.html'), 'utf-8');
  const replacements: Record<string, string> = {
    '{{CONTACT}}': who,
    '{{PAGE}}': page,
    '{{PAGE_PATH}}': page,
    '{{SITE}}': config.PUBLIC_URL,
    '{{NAME}}': config.LEGAL_NAME,
    '{{LAW}}': law,
    '{{TITLE}}': title,
    '{{DESC}}': desc,
  };
  for (const [k, v] of Object.entries(replacements)) {
    html = html.replaceAll(k, v);
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/brand/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+\.(svg|png|ico|webp|jpg|mp4)$/.test(name)) {
    res.status(404).end();
    return;
  }
  const f = path.join(config.WEB_DIR, 'brand', name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Cache-Control', 'public, max-age=604800');
  res.sendFile(f);
});

app.get('/assets/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+\.js$/.test(name)) {
    res.status(404).end();
    return;
  }
  const f = path.join(config.WEB_DIR, name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, no-cache');
  res.sendFile(f);
});

app.get('/favicon.ico', (_req, res) => res.redirect(308, '/brand/favicon.svg'));

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nDisallow: /auth/\nDisallow: /reset\nDisallow: /media/\n\nSitemap: ${config.PUBLIC_URL}/sitemap.xml\n`,
  );
});

app.get('/sitemap.xml', (_req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  const pages = [
    ['/', '1.0', 'weekly'],
    ['/signup', '0.8', 'monthly'],
    ['/login', '0.4', 'monthly'],
    ['/terms', '0.3', 'yearly'],
    ['/privacy', '0.3', 'yearly'],
    ['/acceptable-use', '0.2', 'yearly'],
  ];
  const body = pages
    .map(
      ([u, p, c]) =>
        `<url><loc>${config.PUBLIC_URL}${u}</loc><lastmod>${day}</lastmod><changefreq>${c}</changefreq><priority>${p}</priority></url>`,
    )
    .join('');
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ================================================================ Auth

app.get('/api/public', (_req, res) => {
  res.json({ google: false, mail: false, verify_email: config.VERIFY_EMAIL });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});

app.post('/api/auth/signup', (req, res) => {
  if (!config.ACCOUNTS) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!email || !email.includes('@')) {
    res.status(400).json({ detail: 'Enter a valid email address.' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ detail: 'Choose a password at least 8 characters long.' });
    return;
  }
  const st = getState();
  if (Object.values(st.users).some((u) => u.email.toLowerCase() === email)) {
    res.status(400).json({ detail: 'An account with that email already exists.' });
    return;
  }
  const now = Date.now() / 1000;
  const uid = `u_${crypto.randomBytes(8).toString('hex')}`;
  const isFirst = Object.keys(st.users).length <= 1;
  const user: UserRecord = {
    id: uid,
    email,
    name: name || email.split('@')[0],
    password_hash: hashPassword(password),
    google_sub: '',
    is_admin: isFirst,
    disabled: false,
    verified: true,
    created_at: now,
    last_seen: now,
  };
  st.users[uid] = user;
  const token = crypto.randomBytes(24).toString('hex');
  st.sessions[token] = { user_id: uid, expires_at: now + 30 * 86400 };
  bump(uid);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 * 1000 });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  if (!config.ACCOUNTS) {
    res.status(404).json({ detail: 'Not Found' });
    return;
  }
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const st = getState();
  const user = Object.values(st.users).find((u) => u.email.toLowerCase() === email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash) || user.disabled) {
    res.status(400).json({ detail: 'Wrong email or password.' });
    return;
  }
  const token = crypto.randomBytes(24).toString('hex');
  st.sessions[token] = { user_id: user.id, expires_at: Date.now() / 1000 + 30 * 86400 };
  bump(user.id);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 30 * 86400 * 1000 });
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = String(req.cookies?.[SESSION_COOKIE] || '');
  if (token) delete getState().sessions[token];
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  const cur = String(req.body?.current || '');
  const nextPw = String(req.body?.new || '');
  if (nextPw.length < 8) {
    res.status(400).json({ detail: 'Choose a password at least 8 characters long.' });
    return;
  }
  if (req.user!.password_hash && !verifyPassword(cur, req.user!.password_hash)) {
    res.status(400).json({ detail: 'Your current password is wrong.' });
    return;
  }
  req.user!.password_hash = hashPassword(nextPw);
  bump(req.user!.id);
  res.json({ ok: true });
});

app.post('/api/auth/resend-verification', requireAuth, (_req, res) => {
  res.json({ verified: true });
});

app.post('/api/auth/forgot', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/reset', (_req, res) => {
  res.status(400).json({ detail: 'This reset link is invalid or has expired.' });
});

app.get('/api/me/photo', (_req, res) => {
  res.status(404).end();
});

// ================================================================ Status & Sync

app.get('/api/status', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const settings = getUserSettings(uid);
  res.json({
    user: publicUser(req.user!),
    update: null,
    accounts: config.ACCOUNTS,
    disk_full: false,
    no_ffmpeg: !ffmpegAvailable,
    links: { repo: config.REPO_URL, follow: config.FOLLOW_URL },
    ai: usageBrief(uid),
    unread: getUnreadCount(uid),
    tour: !settings.tour_done,
    youtube: canConnect('youtube'),
    connect: {
      youtube: canConnect('youtube'),
      instagram: canConnect('instagram'),
      tiktok: canConnect('tiktok'),
    },
    max_upload_mb: config.MAX_UPLOAD_MB,
    upload_part_mb: config.UPLOAD_PART_MB,
    max_batch: config.MAX_ACTIVE_JOBS_PER_USER,
    styles: Object.fromEntries(Object.entries(STYLES).map(([k, v]) => [k, v.label])),
    layouts: LAYOUTS,
    speech: getSpeechBrief(),
  });
});

app.get('/api/sync', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const v = String(req.query.v || '');
  const token = syncToken(uid);
  if (v && v === token) {
    res.json({ v: token });
    return;
  }
  res.json({
    v: token,
    jobs: listJobs(uid).map(publicJob),
    creators: creatorRows(uid),
    accounts: listConnectedAccounts(uid),
    ai: usageBrief(uid),
    unread: getUnreadCount(uid),
  });
});

// ================================================================ Videos, Uploads & Clips

app.get('/api/jobs', requireAuth, (req, res) => {
  res.json(listJobs(req.user!.id).map(publicJob));
});

app.get('/api/jobs/:jid', requireAuth, (req, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  res.json(publicJob(job));
});

app.get('/api/preview', requireAuth, async (req, res) => {
  const url = String(req.query.url || '').trim().slice(0, 500);
  if (!siteAllowed(url)) {
    res.status(400).json({ detail: 'Paste a full link to a YouTube, Twitch or Kick video.' });
    return;
  }
  try {
    const info = await fetchLinkPreview(url);
    res.json(info);
  } catch (err) {
    res.status(422).json({ detail: err instanceof Error ? err.message : "Couldn't open that video." });
  }
});

app.post('/api/jobs', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const raw = String(req.body?.url || '').trim().slice(0, 500);
  const url = raw && !raw.includes('://') ? `https://${raw}` : raw;
  if (!siteAllowed(url)) {
    res.status(400).json({ detail: 'Paste a full link to a YouTube, Twitch or Kick video.' });
    return;
  }
  if (busyCount(uid) >= config.MAX_ACTIVE_JOBS_PER_USER) {
    res.status(429).json({
      detail: `You already have ${config.MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const creator = String(req.body?.creator || '') || null;
  if (creator && !getCreator(uid, creator)) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  try {
    const job = createJob({
      uid,
      source: { type: 'url', url, name: url },
      options: req.body?.options || {},
      creator,
    });
    enqueueVideoJob(job);
    res.json(publicJob(job));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : "Those options aren't valid." });
  }
});

app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  const uid = req.user!.id;
  const file = req.file;
  if (!file) {
    res.status(400).json({ detail: 'Choose a video file to upload.' });
    return;
  }
  const cleanName = path
    .basename(file.originalname || 'video.mp4')
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120);
  const ext = path.extname(cleanName).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    fs.rmSync(file.path, { force: true });
    res.status(400).json({ detail: 'Upload a video file (mp4, mov, mkv or webm).' });
    return;
  }
  if (busyCount(uid) >= config.MAX_ACTIVE_JOBS_PER_USER) {
    fs.rmSync(file.path, { force: true });
    res.status(429).json({
      detail: `You already have ${config.MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const creator = String(req.body?.creator || '') || null;
  if (creator && !getCreator(uid, creator)) {
    fs.rmSync(file.path, { force: true });
    res.status(404).json({ detail: 'No such creator' });
    return;
  }

  let opts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(String(req.body?.options || '{}'));
    if (parsed && typeof parsed === 'object') opts = parsed as Record<string, unknown>;
  } catch {
    opts = {};
  }

  try {
    const job = createJob({
      uid,
      source: { type: 'file', name: cleanName, path: file.path },
      options: opts,
      creator,
    });
    const dest = path.join(job.dir, `source${ext}`);
    fs.renameSync(file.path, dest);
    job.source.path = dest;
    job.source_path = dest;
    enqueueVideoJob(job);
    res.json(publicJob(job));
  } catch (err) {
    fs.rmSync(file.path, { force: true });
    res.status(400).json({ detail: err instanceof Error ? err.message : "Those options aren't valid." });
  }
});

// Chunked uploads
interface ChunkedUploadMeta {
  id: string;
  user: string;
  name: string;
  ext: string;
  size: number;
  part: number;
  parts: number;
  options: Record<string, unknown>;
  creator: string | null;
  dir: string;
}

const activeUploads = new Map<string, ChunkedUploadMeta>();

app.post('/api/upload/start', requireAuth, (req, res) => {
  const uid = req.user!.id;
  if (busyCount(uid) >= config.MAX_ACTIVE_JOBS_PER_USER) {
    res.status(429).json({
      detail: `You already have ${config.MAX_ACTIVE_JOBS_PER_USER} videos in progress. Wait for one to finish.`,
    });
    return;
  }
  const name = path
    .basename(String(req.body?.name || 'video.mp4'))
    .replace(/[^\w.\- ]/g, '_')
    .slice(0, 120);
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    res.status(400).json({ detail: 'Upload a video file (mp4, mov, mkv or webm).' });
    return;
  }
  const size = Number(req.body?.size);
  if (!Number.isInteger(size) || size <= 0) {
    res.status(400).json({ detail: 'Bad file size.' });
    return;
  }
  if (size > config.MAX_UPLOAD_MB * 1024 * 1024) {
    res.status(413).json({ detail: `That file is too big. The limit is ${config.MAX_UPLOAD_MB} MB.` });
    return;
  }
  const creator = String(req.body?.creator || '') || null;
  if (creator && !getCreator(uid, creator)) {
    res.status(404).json({ detail: 'No such creator' });
    return;
  }
  const opts = req.body?.options && typeof req.body.options === 'object' ? req.body.options : {};
  try {
    cleanOptions(opts);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : "Those options aren't valid." });
    return;
  }

  const part = config.UPLOAD_PART_MB * 1024 * 1024;
  const parts = Math.ceil(size / part);
  const upid = crypto.randomBytes(12).toString('hex');
  const dir = path.join(config.TMP_DIR, 'uploads', `up-${upid}`);
  fs.mkdirSync(dir, { recursive: true });
  activeUploads.set(upid, { id: upid, user: uid, name, ext, size, part, parts, options: opts, creator, dir });
  res.json({ id: upid, part, parts });
});

app.put(
  '/api/upload/:upid/:n',
  requireAuth,
  express.raw({ type: '*/*', limit: `${config.UPLOAD_PART_MB + 4}mb` }),
  (req, res) => {
    const meta = activeUploads.get(req.params.upid);
    if (!meta || meta.user !== req.user!.id) {
      res.status(404).json({ detail: 'No such upload' });
      return;
    }
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0 || n >= meta.parts) {
      res.status(400).json({ detail: 'No such piece.' });
      return;
    }
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const want = n < meta.parts - 1 ? meta.part : meta.size - meta.part * (meta.parts - 1);
    if (buf.length !== want) {
      res.status(400).json({ detail: 'That piece is the wrong size.' });
      return;
    }
    fs.writeFileSync(path.join(meta.dir, `${String(n).padStart(5, '0')}.part`), buf);
    res.json({ ok: true, n });
  },
);

app.post('/api/upload/:upid/finish', requireAuth, (req, res) => {
  const meta = activeUploads.get(req.params.upid);
  if (!meta || meta.user !== req.user!.id) {
    res.status(404).json({ detail: 'No such upload' });
    return;
  }
  for (let i = 0; i < meta.parts; i++) {
    if (!fs.existsSync(path.join(meta.dir, `${String(i).padStart(5, '0')}.part`))) {
      res.status(400).json({ detail: `Missing piece ${i}.` });
      return;
    }
  }
  const job = createJob({
    uid: meta.user,
    source: { type: 'file', name: meta.name },
    options: meta.options,
    creator: meta.creator,
  });
  const dest = path.join(job.dir, `source${meta.ext}`);
  const outFd = fs.openSync(dest, 'w');
  try {
    for (let i = 0; i < meta.parts; i++) {
      const data = fs.readFileSync(path.join(meta.dir, `${String(i).padStart(5, '0')}.part`));
      fs.writeSync(outFd, data);
    }
  } finally {
    fs.closeSync(outFd);
    fs.rmSync(meta.dir, { recursive: true, force: true });
    activeUploads.delete(meta.id);
  }
  job.source.path = dest;
  job.source_path = dest;
  enqueueVideoJob(job);
  res.json(publicJob(job));
});

app.delete('/api/upload/:upid', requireAuth, (req, res) => {
  const meta = activeUploads.get(req.params.upid);
  if (!meta || meta.user !== req.user!.id) {
    res.status(404).json({ detail: 'No such upload' });
    return;
  }
  fs.rmSync(meta.dir, { recursive: true, force: true });
  activeUploads.delete(meta.id);
  res.json({ ok: true });
});

app.post('/api/jobs/:jid/clips/:cid/render', requireAuth, (req, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  const clip = job.clips.find((c) => c.id === req.params.cid);
  if (!clip) {
    res.status(404).json({ detail: 'No such clip' });
    return;
  }
  if (job.status === 'queued' || job.status === 'running' || clip.status === 'queued' || clip.status === 'rendering') {
    res.status(409).json({ detail: 'This clip is still being made. Try again when it has finished.' });
    return;
  }
  try {
    requestClipRerender(job, clip, req.body || {});
    res.json(publicJob(job));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid render options.' });
  }
});

app.put('/api/jobs/:jid/clips/:cid/text', requireAuth, (req, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  const clip = job.clips.find((c) => c.id === req.params.cid);
  if (!clip) {
    res.status(404).json({ detail: 'No such clip' });
    return;
  }
  savePostText(job, clip, req.body || {});
  res.json(publicJob(job));
});

app.post('/api/jobs/:jid/clips/:cid/write', requireAuth, async (req, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job) {
    res.status(404).json({ detail: 'No such video' });
    return;
  }
  const clip = job.clips.find((c) => c.id === req.params.cid);
  if (!clip) {
    res.status(404).json({ detail: 'No such clip' });
    return;
  }
  try {
    const out = await rewritePostText({
      spoken: spokenInClip(job, clip),
      title: job.title,
      uploader: job.uploader,
      game: job.game,
      uid: req.user!.id,
      creator: job.creator,
    });
    res.json(out);
  } catch (err) {
    res.status(503).json({ detail: err instanceof Error ? err.message : 'AI rewrite failed.' });
  }
});

app.delete('/api/jobs/:jid', requireAuth, (req, res) => {
  try {
    if (!deleteJob(req.user!.id, req.params.jid)) {
      res.status(404).json({ detail: 'No such video' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ detail: err instanceof Error ? err.message : 'Cannot delete video right now.' });
  }
});

app.delete('/api/jobs/:jid/clips/:cid', requireAuth, (req, res) => {
  try {
    if (!deleteClip(req.user!.id, req.params.jid, req.params.cid)) {
      res.status(404).json({ detail: 'No such clip' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ detail: err instanceof Error ? err.message : 'Cannot delete clip right now.' });
  }
});

app.post('/api/bulk/delete', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const videos = Array.isArray(req.body?.videos) ? req.body.videos : [];
  const clips = Array.isArray(req.body?.clips) ? req.body.clips : [];
  let deletedVideos = 0;
  let deletedClips = 0;
  let skipped = 0;

  for (const jid of videos.slice(0, 300)) {
    try {
      if (typeof jid === 'string' && deleteJob(uid, jid)) deletedVideos++;
    } catch {
      skipped++;
    }
  }
  for (const pair of clips.slice(0, 300)) {
    if (Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      try {
        if (deleteClip(uid, pair[0], pair[1])) deletedClips++;
      } catch {
        skipped++;
      }
    }
  }
  res.json({ videos: deletedVideos, clips: deletedClips, skipped });
});

app.get('/api/clips.zip', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const rawIds = String(req.query.ids || '');
  const pairs = rawIds
    .split(',')
    .map((p) => p.split('.', 2))
    .filter((p) => p.length === 2 && /^[\w-]{1,60}$/.test(p[0]) && /^[\w-]{1,60}$/.test(p[1]))
    .slice(0, 300);

  const files: Array<{ filePath: string; name: string }> = [];
  for (const [jid, cid] of pairs) {
    const job = getJob(uid, jid);
    const clip = job?.clips.find((c) => c.id === cid);
    if (!job || !clip || !clip.file) continue;
    const fp = path.join(job.dir, 'clips', clip.file);
    if (!fs.existsSync(fp)) continue;
    const safeTitle = (clip.title || clip.hook || cid).replace(/[^\w\- ]/g, '').trim().slice(0, 60) || cid;
    files.push({ filePath: fp, name: `${safeTitle}-${cid}.mp4` });
  }

  if (files.length === 0) {
    res.status(400).json({ detail: 'None of those clips are ready to download.' });
    return;
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="peakcut-clips-${files.length}.zip"`);
  res.setHeader('Cache-Control', 'private, no-store');

  const archive = createZipArchive({ zlib: { level: 1 } });
  archive.on('error', (err) => {
    console.error('[clips.zip]', err);
    if (!res.headersSent) {
      res.status(500).json({ detail: 'Could not build clips archive.' });
    } else {
      res.end();
    }
  });
  archive.pipe(res);
  for (const item of files) {
    archive.file(item.filePath, { name: item.name });
  }
  void archive.finalize().catch((err) => {
    console.error('[clips.zip finalize]', err);
    if (!res.headersSent) {
      res.status(500).json({ detail: 'Could not finalize clips archive.' });
    } else {
      res.end();
    }
  });
});

app.get('/media/:jid/:name', requireAuth, (req, res) => {
  const { jid, name } = req.params;
  if (!/^[\w-]+\.(mp4|jpg)$/.test(name)) {
    res.status(404).end();
    return;
  }
  const job = getJob(req.user!.id, jid);
  if (!job) {
    res.status(404).end();
    return;
  }
  const f = path.join(job.dir, 'clips', name);
  if (!fs.existsSync(f)) {
    res.status(404).end();
    return;
  }
  if (String(req.query.download || '') === '1' && name.endsWith('.mp4')) {
    const clip = job.clips.find((c) => c.file === name);
    const saveAs =
      ((clip?.title || clip?.hook || path.parse(name).name).replace(/[^\w\- ]/g, '').trim().slice(0, 60) || path.parse(name).name) +
      '.mp4';
    res.download(f, saveAs);
    return;
  }
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(f);
});

// ================================================================ Creators & Live

function validateCreatorChannels(body: Record<string, unknown>): string | null {
  const links: string[] = [];
  if (body.channel) links.push(String(body.channel).trim());
  if (body.channels && typeof body.channels === 'object') {
    for (const [plat, url] of Object.entries(body.channels as Record<string, unknown>)) {
      const s = String(url || '').trim();
      if (s) {
        if (platformKey(s) !== plat) return `That link isn't a ${plat} channel.`;
        links.push(s);
      }
    }
  }
  for (const ch of links) {
    if (ch && !siteAllowed(normalizeChannelUrl(ch))) {
      return 'Channel links must be from YouTube, Twitch or Kick.';
    }
  }
  return null;
}

app.get('/api/channel-preview', requireAuth, async (req, res) => {
  const url = String(req.query.url || '').trim().slice(0, 300);
  try {
    const preview = await fetchChannelPreview(url);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Paste a YouTube, Twitch or Kick channel link.' });
  }
});

app.get('/api/creators/:cid/avatar', (_req, res) => {
  res.status(404).end();
});

app.get('/api/creators', requireAuth, (req, res) => {
  res.json(creatorRows(req.user!.id));
});

app.post('/api/creators', requireAuth, (req, res) => {
  const errMsg = validateCreatorChannels(req.body || {});
  if (errMsg) {
    res.status(400).json({ detail: errMsg });
    return;
  }
  try {
    const c = createCreator(req.user!.id, req.body || {});
    res.json(c);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Could not create creator.' });
  }
});

app.put('/api/creators/:cid', requireAuth, (req, res) => {
  const errMsg = validateCreatorChannels(req.body || {});
  if (errMsg) {
    res.status(400).json({ detail: errMsg });
    return;
  }
  try {
    const c = updateCreator(req.user!.id, req.params.cid, req.body || {});
    res.json(c);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not update creator.';
    res.status(msg === 'No such creator' ? 404 : 400).json({ detail: msg });
  }
});

app.delete('/api/creators/:cid', requireAuth, (req, res) => {
  try {
    const r = deleteCreator(req.user!.id, req.params.cid);
    if (!r.ok) {
      res.status(404).json({ detail: 'No such creator' });
      return;
    }
    res.json(r);
  } catch (err) {
    res.status(409).json({ detail: err instanceof Error ? err.message : 'Creator is busy.' });
  }
});

app.post('/api/creators/:cid/live', requireAuth, (req, res) => {
  try {
    const job = startLiveSession(req.user!.id, req.params.cid, String(req.body?.channel || '') || undefined);
    res.json(publicJob(job));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not start recording.';
    res.status(msg === 'No such creator' ? 404 : 400).json({ detail: msg });
  }
});

app.post('/api/live/:jid/stop', requireAuth, (req, res) => {
  if (!stopLiveSession(req.user!.id, req.params.jid)) {
    res.status(404).json({ detail: 'This recording has already ended' });
    return;
  }
  res.json({ ok: true });
});

app.post('/api/live/:jid/clip', requireAuth, (req, res) => {
  const job = getJob(req.user!.id, req.params.jid);
  if (!job || job.kind !== 'live' || job.status !== 'live') {
    res.status(404).json({ detail: 'This recording has already ended' });
    return;
  }
  res.json({ ok: true });
});

// ================================================================ AI, Speech & Usage

app.get('/api/usage', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const names = Object.fromEntries(listCreators(uid).map((c) => [c.id, c.name]));
  res.json(usageSummary(uid, names));
});

app.get('/api/ai', requireAdmin, (_req, res) => {
  res.json(publicAiConfig());
});

app.put('/api/ai', requireAdmin, (req, res) => {
  const k = req.body?.key;
  const removeKey = Boolean(req.body?.remove_key);
  const keyArg = k === undefined || k === null || (typeof k === 'string' && !k.trim() && !removeKey) ? null : String(k);
  try {
    const out = saveAiConfig(req.body?.provider, req.body?.models, req.body?.base_url || '', keyArg);
    bump();
    res.json(out);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid AI settings.' });
  }
});

app.post('/api/ai/models', requireAdmin, async (req, res) => {
  try {
    const models = await listProviderModels(req.body?.provider, req.body?.base_url, req.body?.key);
    res.json({ models });
  } catch (err) {
    const reason = explainAiError(err);
    res.status(502).json({
      detail: reason || `The service did not give its list of models: ${err instanceof Error ? err.message.slice(0, 160) : 'error'}`,
    });
  }
});

app.post('/api/ai/test', requireAdmin, async (req, res) => {
  try {
    const result = await testAiConnection(req.user!.id);
    res.json(result);
  } catch (err) {
    const reason = explainAiError(err);
    res.status(502).json({
      detail: reason || `The AI did not answer: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
    });
  }
});

app.get('/api/speech', requireAdmin, (_req, res) => {
  res.json({ models: getSpeechList() });
});

app.post('/api/speech/:lang', requireAdmin, (req, res) => {
  const lang = req.params.lang;
  if (!(lang in SPEECH_MODELS_META)) {
    res.status(400).json({ detail: 'PeakCut has no speech model for that language.' });
    return;
  }
  getState().speech[lang] = { state: 'ready', percent: 100, error: '' };
  bump();
  res.json({ models: getSpeechList() });
});

app.delete('/api/speech/:lang', requireAdmin, (req, res) => {
  const lang = req.params.lang;
  if (!(lang in SPEECH_MODELS_META)) {
    res.status(400).json({ detail: 'PeakCut has no speech model for that language.' });
    return;
  }
  if (SPEECH_MODELS_META[lang].default) {
    res.status(400).json({ detail: 'The default English speech model cannot be removed.' });
    return;
  }
  getState().speech[lang] = { state: 'missing', percent: 0, error: '' };
  bump();
  res.json({ models: getSpeechList() });
});

// ================================================================ Overview, Settings, Accounts, Posting, Storage

app.get('/api/overview', requireAuth, (req, res) => {
  res.json(getOverview(req.user!.id));
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(publicUserSettings(req.user!.id));
});

app.put('/api/settings', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const s = getUserSettings(uid);
  const patch = req.body || {};
  if ('paused' in patch) s.paused = Boolean(patch.paused);
  if ('tour_done' in patch) s.tour_done = Boolean(patch.tour_done);
  if ('digest_hour' in patch) s.digest_hour = Math.max(0, Math.min(23, Number(patch.digest_hour) || 8));
  if ('discord_webhook' in patch) {
    const v = String(patch.discord_webhook || '').trim().slice(0, 300);
    if (v && !v.startsWith('https://discord.com/api/webhooks/')) {
      res.status(400).json({ detail: "That doesn't look like a Discord webhook link." });
      return;
    }
    if (v) s.discord_webhook = v;
  }
  if ('telegram_token' in patch) {
    const v = String(patch.telegram_token || '').trim().slice(0, 300);
    if (v) s.telegram_token = v;
  }
  if ('telegram_chat' in patch) {
    s.telegram_chat = String(patch.telegram_chat || '').trim().slice(0, 120);
  }
  bump(uid);
  res.json(publicUserSettings(uid));
});

app.get('/api/accounts', requireAuth, (req, res) => {
  res.json(listConnectedAccounts(req.user!.id));
});

app.delete('/api/accounts/:aid', requireAuth, (req, res) => {
  removeConnectedAccount(req.user!.id, req.params.aid);
  res.json({ ok: true });
});

app.get('/oauth/:platform/start', requireAuth, (req, res) => {
  const platform = req.params.platform;
  if (!(platform in PLATFORM_NAMES)) {
    res.status(404).end();
    return;
  }
  if (!canConnect(platform)) {
    res.redirect(
      303,
      `/app/settings/apps?connect_error=${encodeURIComponent(`Connecting ${PLATFORM_NAMES[platform]} isn't set up on this server yet.`)}`,
    );
    return;
  }
  res.redirect(
    303,
    `/app/settings/apps?connect_error=${encodeURIComponent(`Complete OAuth app verification with ${PLATFORM_NAMES[platform]} to authorize accounts.`)}`,
  );
});

app.get('/api/apps', requireAdmin, (_req, res) => {
  res.json(appsPublic());
});

app.put('/api/apps', requireAdmin, (req, res) => {
  try {
    res.json(saveAppKeys(String(req.body?.platform || ''), String(req.body?.client_id || ''), String(req.body?.client_secret || '')));
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Invalid app credentials.' });
  }
});

app.get('/api/youtube-cookies', requireAdmin, (_req, res) => {
  const saved = fs.existsSync(config.YT_COOKIES);
  res.json({ saved, updated: saved ? Math.floor(fs.statSync(config.YT_COOKIES).mtimeMs / 1000) : 0 });
});

app.put('/api/youtube-cookies', requireAdmin, (req, res) => {
  if (req.body?.remove) {
    fs.rmSync(config.YT_COOKIES, { force: true });
  } else {
    const text = String(req.body?.text || '');
    const rows = text
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('# '))
      .map((l) => l.split('\t'));
    if (text.length > 1_000_000 || !rows.some((r) => r.length === 7 && r[0].includes('youtube.com'))) {
      res.status(400).json({ detail: "That doesn't look like a cookies.txt file with YouTube cookies in it." });
      return;
    }
    const content = text.startsWith('# Netscape') ? text : `# Netscape HTTP Cookie File\n${text}`;
    fs.writeFileSync(config.YT_COOKIES, content, 'utf-8');
  }
  const saved = fs.existsSync(config.YT_COOKIES);
  res.json({ saved, updated: saved ? Math.floor(fs.statSync(config.YT_COOKIES).mtimeMs / 1000) : 0 });
});

function folderSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) total += folderSizeBytes(full);
      else total += fs.statSync(full).size;
    }
  } catch {
    // ignore
  }
  return total;
}

function getStorageInfo() {
  let freeGb = 20;
  let totalGb = 50;
  try {
    const stat = fs.statfsSync(config.DATA_DIR);
    freeGb = (stat.bavail * stat.bsize) / 1e9;
    totalGb = (stat.blocks * stat.bsize) / 1e9;
  } catch {
    // ignore
  }
  return {
    path: config.DATA_DIR,
    drive: path.parse(config.DATA_DIR).root || '/',
    free_gb: Number(freeGb.toFixed(1)),
    total_gb: Number(totalGb.toFixed(1)),
    used_gb: Number((folderSizeBytes(config.DATA_DIR) / 1e9).toFixed(2)),
    min_free_gb: config.MIN_FREE_DISK_GB,
    full: freeGb < config.MIN_FREE_DISK_GB,
    fixed: true,
    pending: '',
    local: false,
  };
}

app.get('/api/storage', requireAdmin, (_req, res) => {
  res.json(getStorageInfo());
});

app.post('/api/storage/open', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'The folder can only be opened on a local desktop machine.' });
});

app.post('/api/storage/pick', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'Type the folder path instead on a remote server.' });
});

app.put('/api/storage', requireAdmin, (_req, res) => {
  res.status(400).json({ detail: 'Storage folder is managed by the container environment.' });
});

app.post('/api/posts', requireAuth, (req, res) => {
  try {
    const made = enqueuePosts(
      req.user!.id,
      String(req.body?.job || ''),
      String(req.body?.clip || ''),
      Array.isArray(req.body?.accounts) ? req.body.accounts.map(String) : [],
      Boolean(req.body?.now),
    );
    if (made.length === 0) {
      res.status(400).json({ detail: 'Nothing was queued. Pick at least one account this clip has not already gone to.' });
      return;
    }
    res.json({ queued: made.length });
  } catch (err) {
    res.status(404).json({ detail: err instanceof Error ? err.message : 'That clip is not ready' });
  }
});

app.post('/api/posts/:pid/:action', requireAuth, (req, res) => {
  try {
    postAction(req.user!.id, req.params.pid, req.params.action);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Post action failed.' });
  }
});

app.post('/api/alerts/test', requireAuth, (req, res) => {
  if (!alertsConfigured(req.user!.id)) {
    res.status(400).json({ detail: 'Save a Discord webhook or Telegram details first.' });
    return;
  }
  res.json({ ok: true });
});

// ================================================================ Feedback & Notifications

app.post('/api/feedback', requireAuth, (req, res) => {
  const kindRaw = String(req.body?.kind || 'other');
  const kind = kindRaw === 'bug' || kindRaw === 'idea' ? kindRaw : 'other';
  const message = String(req.body?.message || '').trim();
  if (message.length < 3) {
    res.status(400).json({ detail: 'Write a few words so we know what you mean.' });
    return;
  }
  if (message.length > 4000) {
    res.status(400).json({ detail: "That's a bit long. Keep it under 4,000 characters." });
    return;
  }
  const id = nextId();
  const now = Date.now() / 1000;
  getState().feedback.unshift({
    id,
    user_id: req.user!.id,
    t: now,
    kind,
    message,
    page: String(req.body?.page || '').slice(0, 200),
    context: String(req.body?.context || '').slice(0, 1000),
    status: 'new',
    updated_at: now,
  });
  addNotice(req.user!.id, 'feedback', 'Feedback received', message.slice(0, 140), '/admin/feedback');
  res.json({ id });
});

app.get('/api/notifications', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const items = getState()
    .notices.filter((n) => n.user_id === uid)
    .slice(0, 40)
    .map((n) => ({
      id: n.id,
      t: n.t,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      read: Boolean(n.read_at),
    }));
  res.json({ unread: getUnreadCount(uid), items });
});

app.post('/api/notifications/read', requireAuth, (req, res) => {
  const uid = req.user!.id;
  const now = Date.now() / 1000;
  for (const n of getState().notices) {
    if (n.user_id === uid && n.read_at === null) n.read_at = now;
  }
  bump(uid);
  res.json({ ok: true });
});

app.post('/api/account/delete', requireAuth, (req, res) => {
  const confirm = String(req.body?.confirm || '').trim().toLowerCase();
  if (confirm !== req.user!.email.toLowerCase()) {
    res.status(400).json({ detail: 'Type your email address exactly to confirm.' });
    return;
  }
  res.status(400).json({ detail: 'The local owner account cannot be deleted while sign-in is disabled.' });
});

// ================================================================ Admin

app.get('/api/admin/overview', requireAdmin, (_req, res) => {
  const st = getState();
  const now = Date.now() / 1000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightSec = midnight.getTime() / 1000;
  const d7 = now - 7 * 86400;
  const d30 = now - 30 * 86400;

  const allJobs = Object.values(st.jobs);
  const allUsers = Object.values(st.users).map((u) => {
    const uJobs = allJobs.filter((j) => j.user === u.id);
    const uUsage = st.usage.filter((x) => x.user_id === u.id);
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.is_admin ? 'admin' : 'user',
      disabled: u.disabled,
      verified: u.verified,
      google: Boolean(u.google_sub),
      created_at: u.created_at,
      last_seen: u.last_seen,
      ai_calls: uUsage.length,
      tokens: uUsage.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
      videos: uJobs.length,
      clips: uJobs.reduce((s, j) => s + j.clips.length, 0),
    };
  });

  const c = currentAiConfig();
  const stor = getStorageInfo();
  res.json({
    totals: {
      users: allUsers.length,
      verified: allUsers.filter((u) => u.verified).length,
      disabled: allUsers.filter((u) => u.disabled).length,
      admins: allUsers.filter((u) => u.role === 'admin').length,
      signups_today: allUsers.filter((u) => u.created_at >= midnightSec).length,
      signups_7d: allUsers.filter((u) => u.created_at >= d7).length,
      signups_30d: allUsers.filter((u) => u.created_at >= d30).length,
      active_7d: allUsers.filter((u) => (u.last_seen || 0) >= d7).length,
      ai_calls: st.usage.length,
      ai_calls_today: st.usage.filter((x) => x.t >= midnightSec).length,
      tokens: st.usage.reduce((s, r) => s + r.tokens_in + r.tokens_out, 0),
      videos: allJobs.length,
      clips: allJobs.reduce((s, j) => s + j.clips.length, 0),
      recording: allJobs.filter((j) => j.kind === 'live' && j.status === 'live').length,
      working: allJobs.filter((j) => j.status === 'queued' || j.status === 'running').length,
    },
    daily: [],
    by_purpose: [],
    users: allUsers,
    log: st.adminLog.slice(0, 50),
    server: {
      speech_model: true,
      speech_more: { Arabic: st.speech.ar?.state === 'ready' },
      ai_key: isAiReady(),
      ai_provider: getAiProviderLabel(),
      ai_model: c.models[0] || '',
      google: false,
      mail: false,
      free_gb: stor.free_gb,
      load: { cpu: 0, ram: 0, disk: 0 },
      running: allJobs.filter((j) => j.status === 'running').length,
      waiting: allJobs.filter((j) => j.status === 'queued').length,
      database: 'json-store',
    },
  });
});

app.get('/api/admin/feedback', requireAdmin, (req, res) => {
  const status = String(req.query.status || '');
  const st = getState();
  const items = st.feedback
    .filter((f) => (!status || f.status === status))
    .slice(0, 300)
    .map((f) => {
      const u = st.users[f.user_id];
      return { ...f, email: u?.email || '', name: u?.name || '' };
    });
  res.json({
    items,
    counts: {
      new: st.feedback.filter((f) => f.status === 'new').length,
      seen: st.feedback.filter((f) => f.status === 'seen').length,
      done: st.feedback.filter((f) => f.status === 'done').length,
    },
  });
});

app.post('/api/admin/feedback/:fid', requireAdmin, (req, res) => {
  const fid = Number(req.params.fid);
  const status = String(req.body?.status || '');
  if (!['new', 'seen', 'done'].includes(status)) {
    res.status(400).json({ detail: 'Unknown status.' });
    return;
  }
  const item = getState().feedback.find((f) => f.id === fid);
  if (!item) {
    res.status(400).json({ detail: 'That message no longer exists.' });
    return;
  }
  item.status = status as 'new' | 'seen' | 'done';
  item.updated_at = Date.now() / 1000;
  bump();
  res.json({ ok: true });
});

app.get('/api/admin/users/:uid', requireAdmin, (req, res) => {
  const st = getState();
  const u = st.users[req.params.uid];
  if (!u) {
    res.status(404).json({ detail: 'No such account' });
    return;
  }
  const mine = st.usage.filter((x) => x.user_id === u.id);
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.is_admin ? 'admin' : 'user',
    disabled: u.disabled,
    created_at: u.created_at,
    last_seen: u.last_seen,
    signed_in_devices: 1,
    recent: mine.slice(-40).reverse().map((x) => ({ t: x.t, tokens: x.tokens_in + x.tokens_out, purpose: x.purpose })),
    by_purpose: [],
  });
});

app.post('/api/admin/users/:uid/disabled', requireAdmin, (req, res) => {
  const u = getState().users[req.params.uid];
  if (!u) {
    res.status(404).json({ detail: 'No such account' });
    return;
  }
  if (u.id === req.user!.id) {
    res.status(400).json({ detail: "You can't disable your own account." });
    return;
  }
  if (u.is_admin) {
    res.status(400).json({ detail: "Admin accounts can't be disabled from here." });
    return;
  }
  u.disabled = Boolean(req.body?.disabled);
  bump();
  res.json({ ok: true, disabled: u.disabled });
});

app.post('/api/admin/users/:uid/delete', requireAdmin, (req, res) => {
  const st = getState();
  const target = st.users[req.params.uid];
  if (!target) {
    res.status(404).json({ detail: 'No such account' });
    return;
  }
  if (target.id === req.user!.id) {
    res.status(400).json({ detail: "You can't delete your own account from here." });
    return;
  }
  if (String(req.body?.confirm || '').trim().toLowerCase() !== target.email.toLowerCase()) {
    res.status(400).json({ detail: "Type the account's email address exactly to confirm." });
    return;
  }
  delete st.users[target.id];
  bump();
  res.json({ ok: true });
});

// Express JSON error fallback
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const msg = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ detail: msg });
});

app.listen(config.PORT, config.HOST, () => {
  console.log(`\n  PeakCut is running: http://${config.HOST}:${config.PORT}\n`);
});
