import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as config from './config.ts';
import { normalizeFacecam, normalizeSplitRatio } from './facecam.ts';
import {
  addCreatorLog,
  bump,
  CREATOR_DEFAULTS,
  type CreatorRecord,
  getCreatorLogs,
  getState,
} from './store.ts';

export const PLATFORMS = ['youtube', 'twitch', 'kick'] as const;

const NUMERIC_LIMITS: Record<string, [number, number]> = {
  min_len: [5, 120],
  max_len: [10, 180],
  max_clips: [1, 20],
  min_score: [0, 100],
  buffer_min: [5, 120],
  live_per_hour: [1, 60],
  ai_every_min: [1, 30],
  auto_jump_pct: [20, 300],
  must_clip_min: [0, 240],
  min_gap_min: [0, 60],
  post_min_score: [0, 100],
  post_gap_min: [5, 1440],
  daily_cap: [1, 50],
};

export function cleanHook(v: unknown): string {
  return String(v ?? '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

export function cleanDescription(v: unknown): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]+/g, ' ').trimEnd())
    .join('\n')
    .trim()
    .slice(0, 2000);
}

export function platformKey(url: string): string {
  if (!url) return '';
  try {
    const h = new URL(url.includes('://') ? url : `https://${url}`).hostname.toLowerCase();
    if (h.includes('youtube') || h === 'youtu.be') return 'youtube';
    if (h.includes('twitch')) return 'twitch';
    if (h.includes('kick')) return 'kick';
  } catch {
    // ignore
  }
  return '';
}

function fixChannels(c: CreatorRecord): CreatorRecord {
  const ch: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.channels || {})) {
    if ((PLATFORMS as readonly string[]).includes(k) && v) {
      ch[k] = v;
    }
  }
  if (c.channel) {
    const pk = platformKey(c.channel);
    if (pk && !Object.values(ch).includes(c.channel)) {
      ch[pk] = ch[pk] || c.channel;
    }
  }
  c.channels = ch;
  if (!c.ai_every_min) c.ai_every_min = 3;
  if (!Object.values(ch).includes(c.channel)) {
    c.channel = PLATFORMS.map((p) => ch[p]).find(Boolean) || '';
  }
  return c;
}

function cleanPatch(data: Record<string, unknown>): Partial<CreatorRecord> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(CREATOR_DEFAULTS)) {
    if (key === 'captions') {
      if (key in data) {
        if (typeof data[key] !== 'boolean') throw new Error('Captions must be on or off.');
        out[key] = data[key];
      }
      continue;
    }
    if (key === 'facecam') {
      if (key in data) {
        if (data[key] === null) {
          out[key] = null;
        } else {
          const norm = normalizeFacecam(data[key]);
          if (!norm) throw new Error('Facecam coordinates must include valid x, y, w, and h values.');
          out[key] = norm;
        }
      }
      continue;
    }
    if (key === 'split_ratio') {
      if (key in data && data[key] !== null && data[key] !== undefined && data[key] !== '') {
        const n = Number(data[key]);
        if (!Number.isFinite(n)) throw new Error('Splitscreen facecam height must be a valid number.');
        out[key] = normalizeSplitRatio(n);
      }
      continue;
    }
    if (!(key in data) || data[key] === null || data[key] === undefined) continue;
    const v = data[key];
    if (key in NUMERIC_LIMITS) {
      const [lo, hi] = NUMERIC_LIMITS[key];
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.max(lo, Math.min(hi, Math.round(n)));
    } else if (key === 'auto_watch' || key === 'autopost' || key === 'ai_only_on_spike') {
      out[key] = Boolean(v);
    } else if (key === 'channels') {
      const ch: Record<string, string> = {};
      if (v && typeof v === 'object') {
        for (const [p, u] of Object.entries(v as Record<string, unknown>)) {
          const s = String(u || '').trim().slice(0, 300);
          if ((PLATFORMS as readonly string[]).includes(p) && s) ch[p] = s;
        }
      }
      out[key] = ch;
    } else if (key === 'accounts') {
      out[key] = Array.isArray(v) ? v.map(String).slice(0, 20) : [];
    } else if (key === 'hook_text') {
      out[key] = cleanHook(v);
    } else if (key === 'description_text') {
      out[key] = cleanDescription(v);
    } else if (key === 'rate_per_1k') {
      const n = Number(v) || 0;
      out[key] = Math.max(0, Math.min(1000, n));
    } else if (key === 'plan') {
      out[key] = v === 'pro' || v === 'max' ? v : 'free';
    } else if (key === 'decide_mode') {
      out[key] = v === 'either' ? 'either' : 'both';
    } else if (key === 'privacy') {
      out[key] = v === 'unlisted' || v === 'private' ? v : 'public';
    } else if (key === 'lang') {
      out[key] = v === 'ar' ? 'ar' : 'en';
    } else {
      out[key] = String(v).trim().slice(0, 300);
    }
  }
  return out as Partial<CreatorRecord>;
}

export function listCreators(uid: string): CreatorRecord[] {
  return Object.values(getState().creators)
    .filter((c) => c.user === uid)
    .sort((a, b) => a.created_at - b.created_at);
}

export function getCreator(uid: string, cid: string): CreatorRecord | null {
  if (!cid || !/^[\w-]{1,60}$/.test(cid)) return null;
  const c = getState().creators[cid];
  return c && c.user === uid ? c : null;
}

export function creatorDir(uid: string, cid: string): string {
  const dir = path.join(config.userDir(uid), 'creators', cid);
  fs.mkdirSync(path.join(dir, 'videos'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'live'), { recursive: true });
  return dir;
}

export function createCreator(uid: string, data: Record<string, unknown>): CreatorRecord {
  const mine = listCreators(uid);
  if (mine.length >= config.MAX_CREATORS) {
    throw new Error(`This server allows ${config.MAX_CREATORS} creators per account.`);
  }
  const patch = cleanPatch(data);
  const name = String(patch.name || '').trim();
  if (!name) throw new Error('Enter a name for this creator.');

  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'creator';
  const cid = `${slug}-${crypto.randomBytes(3).toString('hex')}`;

  const creator = fixChannels({
    ...CREATOR_DEFAULTS,
    ...patch,
    id: cid,
    user: uid,
    name,
    created_at: Date.now() / 1000,
    profiles: {},
  });

  creatorDir(uid, cid);
  getState().creators[cid] = creator;
  addCreatorLog(cid, `Workspace created for ${name}`);
  bump(uid);
  return creator;
}

export function updateCreator(uid: string, cid: string, data: Record<string, unknown>): CreatorRecord {
  const existing = getCreator(uid, cid);
  if (!existing) throw new Error('No such creator');
  const patch = cleanPatch(data);
  const updated = fixChannels({
    ...existing,
    ...patch,
    id: existing.id,
    user: existing.user,
    name: patch.name !== undefined ? String(patch.name).trim() || existing.name : existing.name,
  });
  getState().creators[cid] = updated;
  bump(uid);
  return updated;
}

export function deleteCreator(uid: string, cid: string): { ok: boolean } {
  const existing = getCreator(uid, cid);
  if (!existing) return { ok: false };
  const st = getState();
  const busy = Object.values(st.jobs).some(
    (j) => j.user === uid && j.creator === cid && (j.status === 'queued' || j.status === 'running' || j.status === 'live'),
  );
  if (busy) {
    throw new Error('This creator still has a video or live recording in progress. Stop it or wait first.');
  }
  for (const [jid, j] of Object.entries(st.jobs)) {
    if (j.user === uid && j.creator === cid) {
      fs.rmSync(j.dir, { recursive: true, force: true });
      delete st.jobs[jid];
    }
  }
  delete st.creators[cid];
  delete st.creatorLogs[cid];
  fs.rmSync(path.join(config.userDir(uid), 'creators', cid), { recursive: true, force: true });
  bump(uid);
  return { ok: true };
}

export function creatorRows(uid: string) {
  const st = getState();
  return listCreators(uid).map((c) => {
    const liveJob = Object.values(st.jobs).find(
      (j) => j.user === uid && j.creator === c.id && j.kind === 'live' && j.status === 'live',
    );
    return {
      ...c,
      live_job: liveJob ? liveJob.id : null,
      log: getCreatorLogs(c.id, 30),
    };
  });
}
