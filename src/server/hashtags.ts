import { tagsOfGame } from './games.ts';

export const MOST = 5;
export const LEAST = 3;

const STOP = new Set(
  `about above after again against all also always among and another any anyone anything are around because been before being
between both but came can cannot come could did does doing done dont down each else even ever every everyone everything
find first for from gave get gets getting give going gone gonna good got great guys had has have having here him his how
into its just keep kind know last left let like little look looking made make makes many may maybe mean more most much must
myself need never next nobody not nothing now off okay once one only onto other our out over own people put really right
said same say says see she should since some someone something still such sure take than that the their them then there
these they thing things think this those though through time too took try under until upon use very want wanna was way we
well went were what when where whether which while who whole why will with without won would yeah yes you your
hai kya yaar nahi nahin bhai toh aur mein tha kar karo kiya ho hain bhi koi abhi main mera tera apna isko usko jab tab phir
woh wo ye yeh hum tum aap kuch sab bohot bahut matlab accha acha theek lekin par kyun kaise
actual actually literally basically honestly probably definitely obviously seriously totally bro dude man chat stream video
fuck fucking fucked shit damn bitch bitches ass dick pussy sex nigga nigger niggas porn rape`.split(/\s+/),
);

const CATEGORY_TAGS: Record<string, string> = {
  funny: 'funny',
  fail: 'fails',
  clutch: 'clutch',
  rage: 'rage',
  shock: 'shocking',
  take: 'hottake',
  story: 'storytime',
};

const FILLER = ['shorts', 'clips', 'viral'];
const CHANNEL_NOISE = new Set([
  'live',
  'official',
  'tv',
  'gaming',
  'clips',
  'channel',
  'highlights',
  'youtube',
  'twitch',
  'kick',
  'tiktok',
  'stream',
]);

export const TAG_IN_TEXT = /(?:^|\s)#\w+/g;

function cleanTag(s: unknown): string {
  const t = String(s ?? '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    .slice(0, 30);
  if (t.length < 3 || /^\d+$/.test(t) || STOP.has(t)) return '';
  return t;
}

export function channelTag(uploader: string): string {
  const words = (String(uploader || '').match(/[A-Za-z0-9]+/g) || []).filter(
    (w) => !CHANNEL_NOISE.has(w.toLowerCase()),
  );
  const t = cleanTag(words.join(''));
  return t.length >= 3 && t.length <= 25 ? t : '';
}

export function numberedTags(title: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Za-z]{2,12})\s+(\d{1,2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(title || ''))) !== null) {
    if (!STOP.has(m[1].toLowerCase())) {
      const t = cleanTag(m[1] + m[2]);
      if (t) out.push(t);
    }
  }
  return out;
}

export function extractKeywords(text: string, title = '', count = 2): string[] {
  const raw = String(text || '').split(/\s+/).filter(Boolean);
  const wordRe = /[A-Za-z][A-Za-z0-9']{2,19}/g;
  const inTitle = new Set((String(title || '').match(wordRe) || []).map((w) => w.toLowerCase()));
  const score = new Map<string, number>();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const m = r.match(/[A-Za-z][A-Za-z0-9']{2,19}/);
    if (!m) continue;
    const w = m[0].replace(/^'+|'+$/g, '').toLowerCase();
    if (STOP.has(w) || w.length < 4 || !cleanTag(w)) continue;
    const isName =
      /^[A-Z]/.test(r) && i > 0 && !/[.?!]$/.test(raw[i - 1]);
    score.set(w, (score.get(w) ?? 0) + 1 + (isName ? 2 : 0) + (inTitle.has(w) ? 2 : 0));
  }

  return [...score.entries()]
    .filter(([, v]) => v >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .map(([w]) => w)
    .slice(0, count);
}

export function makeHashtags(opts: {
  text?: string;
  title?: string;
  uploader?: string;
  game?: string | null;
  category?: string;
  aiTags?: string[];
  limit?: number;
}): string[] {
  const limit = opts.limit ?? MOST;
  const out: string[] = [];
  const add = (candidate: string) => {
    const t = cleanTag(candidate);
    if (t && !out.includes(t) && out.length < limit) out.push(t);
  };

  for (const t of tagsOfGame(opts.game).slice(0, 1)) add(t);
  add(channelTag(opts.uploader || ''));
  for (const t of (opts.aiTags || []).slice(0, 2)) add(t);
  for (const t of extractKeywords(opts.text || '', opts.title || '')) add(t);
  for (const t of numberedTags(opts.title || '').slice(0, 1)) add(t);
  add(CATEGORY_TAGS[String(opts.category || '').toLowerCase()] || '');
  for (const t of FILLER) {
    if (out.length < LEAST) add(t);
  }
  return out;
}

export interface WordStamp {
  w: string;
  s: number;
  e: number;
}

export function applyHashtags<T extends {
  start: number;
  end: number;
  category?: string;
  hashtags?: string[];
  description?: string;
  fixed_description?: boolean;
  hashtags_in_description?: boolean;
}>(clip: T, words: WordStamp[], title = '', uploader = '', game: string | null = null): T {
  if (clip.fixed_description) return clip;
  const text = words
    .filter((w) => w.s >= clip.start && w.s <= clip.end)
    .map((w) => w.w)
    .join(' ');
  const tags = makeHashtags({
    text,
    title,
    uploader,
    game,
    category: clip.category || 'other',
    aiTags: clip.hashtags || [],
  });
  const desc = String(clip.description || '').replace(TAG_IN_TEXT, '').trim();
  const line = tags.map((t) => `#${t}`).join(' ');
  clip.hashtags = tags;
  clip.hashtags_in_description = true;
  clip.description = desc ? `${desc}\n\n${line}`.trim() : line;
  return clip;
}
