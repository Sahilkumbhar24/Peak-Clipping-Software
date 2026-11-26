import crypto from 'node:crypto';
import * as config from './config.ts';
import { listCreators } from './creators.ts';
import { listJobs } from './jobs.ts';
import { bump, getState, getUserSettings, type PostRecord } from './store.ts';

export const PLATFORM_NAMES: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
};

const APP_META: Record<string, { name: string; idLabel: string; secretLabel: string; idEnv: string; secretEnv: string }> = {
  youtube: { name: 'google', idLabel: 'Client ID', secretLabel: 'Client secret', idEnv: 'GOOGLE_CLIENT_ID', secretEnv: 'GOOGLE_CLIENT_SECRET' },
  instagram: { name: 'instagram', idLabel: 'Instagram app ID', secretLabel: 'Instagram app secret', idEnv: 'PEAKCUT_IG_APP_ID', secretEnv: 'PEAKCUT_IG_APP_SECRET' },
  tiktok: { name: 'tiktok', idLabel: 'Client key', secretLabel: 'Client secret', idEnv: 'PEAKCUT_TIKTOK_CLIENT_KEY', secretEnv: 'PEAKCUT_TIKTOK_CLIENT_SECRET' },
};

const OPEN_STATUSES = new Set(['scheduled', 'posting']);

function appKeys(platform: string): [string, string] {
  const meta = APP_META[platform];
  if (!meta) return ['', ''];
  const saved = getState().apps[meta.name];
  if (saved?.id && saved?.secret) return [saved.id, saved.secret];
  return [(process.env[meta.idEnv] || '').trim(), (process.env[meta.secretEnv] || '').trim()];
}

export function canConnect(platform: string): boolean {
  const [id, secret] = appKeys(platform);
  return Boolean(id && secret);
}

export function appsPublic() {
  const out: Record<string, unknown> = {};
  for (const [platform, meta] of Object.entries(APP_META)) {
    const [cid, secret] = appKeys(platform);
    const saved = getState().apps[meta.name];
    out[platform] = {
      ready: Boolean(cid && secret),
      id_label: meta.idLabel,
      secret_label: meta.secretLabel,
      id_hint: cid.length > 10 ? `${cid.slice(0, 6)}…` : cid,
      redirect: `${config.PUBLIC_URL}/oauth/${platform}/callback`,
      https: config.PUBLIC_URL.startsWith('https://'),
      from_dashboard: Boolean(saved?.id),
    };
  }
  return out;
}

export function saveAppKeys(platform: string, clientId: string, clientSecret: string) {
  const meta = APP_META[platform];
  if (!meta) throw new Error('Unknown platform.');
  const cid = String(clientId || '').trim().slice(0, 200);
  const secret = String(clientSecret || '').trim().slice(0, 300);
  const old = getState().apps[meta.name] || { id: '', secret: '' };
  const finalCid = cid || old.id;
  const finalSecret = secret || (old.id === finalCid ? old.secret : '');
  if (!finalCid || !finalSecret) {
    throw new Error(`Paste the ${meta.idLabel} and ${meta.secretLabel}.`);
  }
  getState().apps[meta.name] = { id: finalCid, secret: finalSecret };
  bump();
  return appsPublic();
}

export function listConnectedAccounts(uid: string) {
  return getState()
    .accounts.filter((a) => a.user === uid)
    .map((a) => ({
      id: a.id,
      platform: a.platform,
      label: PLATFORM_NAMES[a.platform] || a.platform,
      name: a.name,
      added: a.added,
      detail: a.detail || '',
    }));
}

export function removeConnectedAccount(uid: string, aid: string): void {
  const st = getState();
  st.accounts = st.accounts.filter((a) => !(a.user === uid && a.id === aid));
  bump(uid);
}

export function alertsConfigured(uid: string): boolean {
  const s = getUserSettings(uid);
  return Boolean(s.discord_webhook || (s.telegram_token && s.telegram_chat));
}

export function enqueuePosts(uid: string, jobId: string, clipId: string, accountIds: string[], now = false): PostRecord[] {
  const st = getState();
  const job = st.jobs[jobId];
  if (!job || job.user !== uid) throw new Error('That clip is not ready');
  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip || clip.status !== 'done') throw new Error('That clip is not ready');

  const made: PostRecord[] = [];
  const baseTime = Date.now() / 1000;
  for (const aid of accountIds.slice(0, 20)) {
    const acc = st.accounts.find((a) => a.user === uid && a.id === aid);
    if (!acc) continue;
    const dup = st.posts.some((p) => p.user === uid && p.job === jobId && p.clip === clipId && p.account === aid && p.status !== 'cancelled');
    if (dup) continue;
    const post: PostRecord = {
      id: crypto.randomBytes(6).toString('hex'),
      user: uid,
      job: jobId,
      clip: clipId,
      creator: job.creator,
      account: acc.id,
      account_name: acc.name,
      platform: acc.platform,
      title: clip.title || clip.hook || clip.id,
      status: 'scheduled',
      due_at: now ? baseTime : baseTime + 1800,
      posted_at: 0,
      tries: 0,
      views: 0,
      error: null,
    };
    st.posts.push(post);
    made.push(post);
  }
  if (made.length > 0) bump(uid);
  return made;
}

export function postAction(uid: string, pid: string, action: string): void {
  const st = getState();
  const p = st.posts.find((x) => x.user === uid && x.id === pid);
  if (!p) throw new Error('No such post.');
  if (action === 'cancel') {
    if (p.status !== 'scheduled') throw new Error('Only posts that are still waiting can be cancelled.');
    p.status = 'cancelled';
  } else if (action === 'retry') {
    if (p.status !== 'failed' && p.status !== 'cancelled') throw new Error('Only failed or cancelled posts can be retried.');
    p.status = 'scheduled';
    p.due_at = Date.now() / 1000;
    p.tries = 0;
    p.error = null;
  } else {
    throw new Error('Unknown action.');
  }
  bump(uid);
}

function dayStr(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export function getOverview(uid: string) {
  const now = Date.now() / 1000;
  const today = dayStr(now);
  const allCreators = listCreators(uid);
  const allJobs = listJobs(uid);
  const myPosts = getState().posts.filter((p) => p.user === uid);
  const settings = getUserSettings(uid);

  const creatorRows = allCreators.map((c) => {
    const js = allJobs.filter((j) => j.creator === c.id);
    const clips = js.flatMap((j) => j.clips.filter((k) => k.status === 'done'));
    const ps = myPosts.filter((p) => p.creator === c.id);
    const views = ps.reduce((sum, p) => sum + (p.views || 0), 0);
    const isLive = js.some((j) => j.kind === 'live' && j.status === 'live');
    return {
      id: c.id,
      name: c.name,
      state: isLive ? 'recording' : c.auto_watch && c.channel ? 'waiting' : 'idle',
      autopost: Boolean(c.autopost && c.accounts.length > 0),
      clips_today: clips.filter((k) => k.made_at && dayStr(k.made_at) === today).length,
      clips_total: clips.length,
      posted_today: ps.filter((p) => p.status === 'posted' && p.posted_at && dayStr(p.posted_at) === today).length,
      posted_total: ps.filter((p) => p.status === 'posted').length,
      queued: ps.filter((p) => OPEN_STATUSES.has(p.status)).length,
      failed: ps.filter((p) => p.status === 'failed').length,
      views,
      earnings: Number(((views / 1000) * (c.rate_per_1k || 0)).toFixed(2)),
    };
  });

  const names = Object.fromEntries(allCreators.map((c) => [c.id, c.name]));
  const queue = myPosts.filter((p) => OPEN_STATUSES.has(p.status)).sort((a, b) => a.due_at - b.due_at);
  const done = myPosts
    .filter((p) => p.status === 'posted' || p.status === 'failed')
    .sort((a, b) => (b.posted_at || b.due_at) - (a.posted_at || a.due_at))
    .slice(0, 15);
  const show = [...queue, ...done].map(({ user: _u, ...rest }) => ({
    ...rest,
    creator_name: rest.creator ? names[rest.creator] || '' : '',
  }));

  const days: string[] = [];
  const madeMap = new Map<string, number>();
  const postedMap = new Map<string, number>();
  const viewsMap = new Map<string, number>();
  for (let i = 13; i >= 0; i--) {
    const d = dayStr(now - i * 86400);
    days.push(d);
    madeMap.set(d, 0);
    postedMap.set(d, 0);
    viewsMap.set(d, 0);
  }

  for (const j of allJobs) {
    for (const k of j.clips) {
      const d = dayStr(k.made_at || j.created);
      if (k.status === 'done' && madeMap.has(d)) {
        madeMap.set(d, (madeMap.get(d) || 0) + 1);
      }
    }
  }
  for (const p of myPosts) {
    if (p.status === 'posted' && p.posted_at) {
      const d = dayStr(p.posted_at);
      if (postedMap.has(d)) {
        postedMap.set(d, (postedMap.get(d) || 0) + 1);
        viewsMap.set(d, (viewsMap.get(d) || 0) + (p.views || 0));
      }
    }
  }

  const recording = allJobs.filter((j) => j.kind === 'live' && j.status === 'live').length;

  return {
    paused: settings.paused,
    creators: creatorRows,
    posts: show,
    daily: days.map((d) => ({
      day: d,
      clips: madeMap.get(d) || 0,
      posted: postedMap.get(d) || 0,
      views: viewsMap.get(d) || 0,
    })),
    alerts: alertsConfigured(uid),
    recording,
  };
}
