import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.ts';
import type { FacecamRect } from './facecam.ts';
import type { SourceFacecamBox, TrackPoint } from './vision.ts';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  google_sub: string;
  is_admin: boolean;
  disabled: boolean;
  verified: boolean;
  created_at: number;
  last_seen: number;
}

export interface CreatorRecord {
  id: string;
  user: string;
  name: string;
  channel: string;
  channels: Record<string, string>;
  profiles?: Record<string, { channel: string; title?: string; live?: boolean; updated?: number }>;
  style: string;
  layout: string;
  captions: boolean;
  min_len: number;
  max_len: number;
  max_clips: number;
  min_score: number;
  auto_watch: boolean;
  buffer_min: number;
  live_per_hour: number;
  ai_every_min: number;
  ai_only_on_spike: boolean;
  auto_jump_pct: number;
  plan: 'free' | 'pro' | 'max';
  decide_mode: 'both' | 'either';
  must_clip_min: number;
  min_gap_min: number;
  game: string;
  hook_text: string;
  description_text: string;
  trigger_words: string;
  autopost: boolean;
  accounts: string[];
  post_min_score: number;
  post_gap_min: number;
  daily_cap: number;
  privacy: 'public' | 'unlisted' | 'private';
  post_footer: string;
  rate_per_1k: number;
  lang: string;
  facecam: FacecamRect | null;
  split_ratio?: number;
  created_at: number;
}

export interface ClipRecord {
  id: string;
  start: number;
  end: number;
  score: number;
  category: string;
  hook: string;
  title: string;
  description: string;
  hashtags: string[];
  hashtags_in_description?: boolean;
  fixed_description?: boolean;
  highlight_words: string[];
  reason: string;
  style: string;
  layout: string;
  captions: boolean;
  status: 'queued' | 'rendering' | 'done' | 'error';
  version: number;
  file?: string;
  cover?: string;
  error?: string | null;
  made_at?: number;
  facecam?: number[] | FacecamRect | null;
  source_facecam?: SourceFacecamBox | null;
  track_points?: TrackPoint[] | null;
  resolved_layout?: string;
  spoken_excerpt?: string;
  split_ratio?: number;
  src?: string;
  src_offset?: number;
  src_end?: number;
}

export interface JobRecord {
  id: string;
  user: string;
  kind: 'video' | 'live';
  creator: string | null;
  dir: string;
  source_path?: string;
  created: number;
  source: { type: 'file' | 'url' | 'live'; name: string; url?: string; path?: string };
  options: Record<string, unknown>;
  status: 'queued' | 'running' | 'done' | 'error' | 'live';
  stage: string;
  progress: number;
  title: string;
  uploader: string;
  duration: number;
  width: number;
  height: number;
  has_audio?: boolean;
  thumb?: boolean;
  game?: string | null;
  lang?: string;
  source_facecam?: SourceFacecamBox | null;
  video_type?: string;
  recommended_layout?: string;
  framing_summary?: string;
  primary_subject_x?: number;
  transcript_info?: { words: number; coverage_pct: number; source: 'subtitles' | 'gemini' | 'none' };
  clips: ClipRecord[];
  error: string | null;
  ai: { tokens?: number; note?: string; model?: string };
}

export interface ConnectedAccount {
  id: string;
  user: string;
  platform: 'youtube' | 'instagram' | 'tiktok';
  name: string;
  added: number;
  detail?: string;
}

export interface PostRecord {
  id: string;
  user: string;
  job: string;
  clip: string;
  creator: string | null;
  account: string;
  account_name: string;
  platform: string;
  title: string;
  status: 'scheduled' | 'posting' | 'posted' | 'failed' | 'cancelled';
  due_at: number;
  posted_at: number;
  tries: number;
  views: number;
  url?: string;
  error: string | null;
}

export interface UserSettings {
  discord_webhook: string;
  telegram_token: string;
  telegram_chat: string;
  paused: boolean;
  digest_hour: number;
  last_digest: string;
  tour_done: boolean;
}

export interface UsageRow {
  id: number;
  user_id: string;
  t: number;
  tokens_in: number;
  tokens_out: number;
  purpose: string;
  creator: string | null;
  place: string;
}

export interface NoticeRow {
  id: number;
  user_id: string;
  t: number;
  kind: string;
  title: string;
  body: string;
  link: string;
  read_at: number | null;
  ref?: string;
}

export interface FeedbackRow {
  id: number;
  user_id: string;
  t: number;
  kind: 'bug' | 'idea' | 'other';
  message: string;
  page: string;
  context: string;
  status: 'new' | 'seen' | 'done';
  updated_at: number;
}

export interface AdminLogRow {
  t: number;
  admin_id: string;
  action: string;
  target: string;
  detail: string;
}

export interface SpeechModelState {
  lang: string;
  label: string;
  size_mb: number;
  credit: string;
  state: 'ready' | 'downloading' | 'missing';
  percent: number;
  error: string;
  default: boolean;
}

interface PersistedState {
  users: Record<string, UserRecord>;
  sessions: Record<string, { user_id: string; expires_at: number }>;
  creators: Record<string, CreatorRecord>;
  creatorLogs: Record<string, Array<{ t: number; msg: string }>>;
  jobs: Record<string, JobRecord>;
  accounts: ConnectedAccount[];
  posts: PostRecord[];
  settings: Record<string, UserSettings>;
  usage: UsageRow[];
  notices: NoticeRow[];
  feedback: FeedbackRow[];
  adminLog: AdminLogRow[];
  apps: Record<string, { id: string; secret: string }>;
  speech: Record<string, { state: 'ready' | 'downloading' | 'missing'; percent: number; error: string }>;
  nextId: number;
}

export const BOOT_ID = crypto.randomBytes(4).toString('hex');
export const LOCAL_USER_ID = 'local_owner';

export const SETTING_DEFAULTS: UserSettings = {
  discord_webhook: '',
  telegram_token: '',
  telegram_chat: '',
  paused: false,
  digest_hour: 8,
  last_digest: '',
  tour_done: true,
};

export const CREATOR_DEFAULTS = {
  name: '',
  channel: '',
  channels: {} as Record<string, string>,
  style: 'bounce',
  layout: 'smart',
  captions: true,
  min_len: 15,
  max_len: 60,
  max_clips: 6,
  min_score: 80,
  auto_watch: false,
  buffer_min: 20,
  live_per_hour: 4,
  ai_every_min: 3,
  ai_only_on_spike: true,
  auto_jump_pct: 60,
  plan: 'free' as const,
  decide_mode: 'both' as const,
  must_clip_min: 0,
  min_gap_min: 2,
  game: '',
  hook_text: '',
  description_text: '',
  trigger_words: 'clip that, clip it',
  autopost: false,
  accounts: [] as string[],
  post_min_score: 75,
  post_gap_min: 45,
  daily_cap: 6,
  privacy: 'public' as const,
  post_footer: '',
  rate_per_1k: 0.0,
  lang: 'en',
  facecam: null as FacecamRect | null,
  split_ratio: 0.4,
};

export const SPEECH_MODELS_META: Record<string, { label: string; size_mb: number; credit: string; default: boolean }> = {
  en: { label: 'English', size_mb: 480, credit: 'Gemini 3.5 Transcribe / Parakeet TDT (CC-BY-4.0)', default: true },
  ar: { label: 'Arabic', size_mb: 107, credit: 'Gemini 3.5 Transcribe / FastConformer Arabic (CC-BY-4.0)', default: false },
};

const STATE_FILE = path.join(config.DATA_DIR, 'state.json');

const versions = new Map<string, number>();

function createInitialState(): PersistedState {
  const now = Date.now() / 1000;
  const localUser: UserRecord = {
    id: LOCAL_USER_ID,
    email: 'owner@local.peakcut',
    name: 'Owner',
    password_hash: '',
    google_sub: '',
    is_admin: true,
    disabled: false,
    verified: true,
    created_at: now,
    last_seen: now,
  };
  return {
    users: { [LOCAL_USER_ID]: localUser },
    sessions: {},
    creators: {},
    creatorLogs: {},
    jobs: {},
    accounts: [],
    posts: [],
    settings: { [LOCAL_USER_ID]: { ...SETTING_DEFAULTS } },
    usage: [],
    notices: [],
    feedback: [],
    adminLog: [],
    apps: {},
    speech: {
      en: { state: 'ready', percent: 100, error: '' },
      ar: { state: 'ready', percent: 100, error: '' },
    },
    nextId: 1,
  };
}

let state: PersistedState = loadState();

function loadState(): PersistedState {
  config.ensureDirs();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as Partial<PersistedState>;
      const base = createInitialState();
      const merged: PersistedState = {
        ...base,
        ...parsed,
        users: { ...base.users, ...(parsed.users || {}) },
        speech: { ...base.speech, ...(parsed.speech || {}) },
      };
      // Reset any jobs interrupted mid-run on restart
      for (const j of Object.values(merged.jobs)) {
        if (j.status === 'running' || j.status === 'queued') {
          j.status = 'error';
          j.stage = 'Interrupted';
          j.error = 'The server restarted while this video was processing. Add it again to retry.';
        } else if (j.status === 'live') {
          j.status = 'done';
          j.stage = 'Recording ended';
        }
      }
      return merged;
    }
  } catch {
    // ignore corrupt state file and start fresh
  }
  return createInitialState();
}

let saveTimer: NodeJS.Timeout | null = null;

export function persistNow(): void {
  config.ensureDirs();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, STATE_FILE);
}

export function schedulePersist(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      persistNow();
    } catch {
      // ignore background flush errors
    }
  }, 150);
}

export function bump(uid?: string | null): void {
  if (uid) {
    versions.set(uid, (versions.get(uid) ?? 0) + 1);
  } else {
    for (const id of Object.keys(state.users)) {
      versions.set(id, (versions.get(id) ?? 0) + 1);
    }
  }
  schedulePersist();
}

export function syncToken(uid: string): string {
  const v = versions.get(uid) ?? 0;
  return `${BOOT_ID}.${v}.0`;
}

export function nextId(): number {
  const id = state.nextId++;
  schedulePersist();
  return id;
}

export function getState(): PersistedState {
  return state;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export function publicUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email.split('@')[0],
    is_admin: Boolean(u.is_admin),
    role: u.is_admin ? 'admin' : 'user',
    has_password: Boolean(u.password_hash),
    google: Boolean(u.google_sub),
    created_at: u.created_at,
    verified: u.verified || !config.VERIFY_EMAIL,
    photo: 0,
  };
}

export function getLocalUser(): UserRecord {
  return state.users[LOCAL_USER_ID];
}

export function getUserSettings(uid: string): UserSettings {
  if (!state.settings[uid]) {
    state.settings[uid] = { ...SETTING_DEFAULTS };
  }
  return state.settings[uid];
}

export function publicUserSettings(uid: string) {
  const s = getUserSettings(uid);
  return {
    ...s,
    discord_webhook: Boolean(s.discord_webhook),
    telegram_token: Boolean(s.telegram_token),
  };
}

export function addCreatorLog(cid: string | null | undefined, msg: string): void {
  if (!cid) return;
  if (!state.creatorLogs[cid]) state.creatorLogs[cid] = [];
  state.creatorLogs[cid].push({ t: Date.now() / 1000, msg: msg.slice(0, 300) });
  if (state.creatorLogs[cid].length > 100) {
    state.creatorLogs[cid] = state.creatorLogs[cid].slice(-100);
  }
  schedulePersist();
}

export function getCreatorLogs(cid: string, limit = 30): Array<{ t: number; msg: string }> {
  return (state.creatorLogs[cid] || []).slice(-limit);
}

export function recordUsage(uid: string, tokensIn: number, tokensOut: number, purpose: string, creator?: string | null, place = ''): void {
  state.usage.push({
    id: nextId(),
    user_id: uid,
    t: Date.now() / 1000,
    tokens_in: Math.max(0, Math.round(tokensIn)),
    tokens_out: Math.max(0, Math.round(tokensOut)),
    purpose: purpose.slice(0, 60),
    creator: creator ?? null,
    place: place.slice(0, 200),
  });
  if (state.usage.length > 2000) {
    state.usage = state.usage.slice(-2000);
  }
  bump(uid);
}

export function addNotice(uid: string, kind: string, title: string, body = '', link = '', ref?: string): void {
  if (ref && state.notices.some((n) => n.user_id === uid && n.ref === ref)) return;
  state.notices.unshift({
    id: nextId(),
    user_id: uid,
    t: Date.now() / 1000,
    kind: kind.slice(0, 20),
    title: title.slice(0, 160),
    body: body.slice(0, 400),
    link: link.slice(0, 200),
    read_at: null,
    ref,
  });
  const mine = state.notices.filter((n) => n.user_id === uid);
  if (mine.length > 60) {
    const keepIds = new Set(mine.slice(0, 60).map((n) => n.id));
    state.notices = state.notices.filter((n) => n.user_id !== uid || keepIds.has(n.id));
  }
  bump(uid);
}

export function getUnreadCount(uid: string): number {
  return state.notices.filter((n) => n.user_id === uid && n.read_at === null).length;
}

export function getSpeechBrief(): Record<string, { label: string; size_mb: number; state: string }> {
  const out: Record<string, { label: string; size_mb: number; state: string }> = {};
  for (const [k, meta] of Object.entries(SPEECH_MODELS_META)) {
    const st = state.speech[k]?.state ?? 'ready';
    out[k] = { label: meta.label, size_mb: meta.size_mb, state: st };
  }
  return out;
}

export function getSpeechList(): SpeechModelState[] {
  return Object.entries(SPEECH_MODELS_META).map(([lang, meta]) => {
    const cur = state.speech[lang] ?? { state: 'ready', percent: 100, error: '' };
    return {
      lang,
      label: meta.label,
      size_mb: meta.size_mb,
      credit: meta.credit,
      state: cur.state,
      percent: cur.percent,
      error: cur.error,
      default: meta.default,
    };
  });
}
