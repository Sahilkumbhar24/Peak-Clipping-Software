import { GoogleGenAI, Type } from '@google/genai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from './config.ts';
import { splitAudioChunks } from './media.ts';
import { getState, recordUsage } from './store.ts';
import type { WordStamp } from './hashtags.ts';

export interface ProviderDef {
  id: string;
  label: string;
  address: string;
  how: 'gemini' | 'openai' | 'anthropic';
  key_url: string;
  example: string;
  needs_key: boolean;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    address: 'https://generativelanguage.googleapis.com/v1beta/models',
    how: 'gemini',
    key_url: 'https://aistudio.google.com/apikey',
    example: 'gemini-4-hydrogen',
    needs_key: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    address: 'https://api.openai.com/v1',
    how: 'openai',
    key_url: 'https://platform.openai.com/api-keys',
    example: 'gpt-4o-mini',
    needs_key: true,
  },
  xai: {
    id: 'xai',
    label: 'Grok',
    address: 'https://api.x.ai/v1',
    how: 'openai',
    key_url: 'https://console.x.ai',
    example: 'grok-4',
    needs_key: true,
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    address: 'https://api.groq.com/openai/v1',
    how: 'openai',
    key_url: 'https://console.groq.com/keys',
    example: 'llama-3.3-70b-versatile',
    needs_key: true,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    address: 'https://openrouter.ai/api/v1',
    how: 'openai',
    key_url: 'https://openrouter.ai/keys',
    example: 'google/gemini-2.5-flash',
    needs_key: true,
  },
  anthropic: {
    id: 'anthropic',
    label: 'Claude',
    address: 'https://api.anthropic.com/v1',
    how: 'anthropic',
    key_url: 'https://console.anthropic.com',
    example: 'claude-sonnet-4-5',
    needs_key: true,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (on this machine)',
    address: 'http://127.0.0.1:11434/v1',
    how: 'openai',
    key_url: 'https://ollama.com',
    example: 'llama3.1',
    needs_key: false,
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    address: '',
    how: 'openai',
    key_url: '',
    example: '',
    needs_key: false,
  },
};

const ALIASES: Record<string, string> = {
  google: 'gemini',
  grok: 'xai',
  claude: 'anthropic',
  local: 'ollama',
};

const NO_KEY = new Set(['ollama', 'custom']);
const AI_FILE = path.join(config.DATA_DIR, 'ai.json');

export const DEFAULT_GEMINI_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];

export const aiProblem = { text: '', at: 0, transient: false };

interface SavedAiConfig {
  provider?: string;
  models?: string[];
  base_url?: string;
  key?: string;
}

function readDashboardAi(): SavedAiConfig {
  try {
    if (fs.existsSync(AI_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(AI_FILE, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed as SavedAiConfig;
    }
  } catch {
    // ignore
  }
  return {};
}

export function currentAiConfig() {
  const saved = readDashboardAi();
  const envGeminiKey = (process.env.GEMINI_API_KEY || '').trim();
  const hasRealEnvGemini = Boolean(envGeminiKey && envGeminiKey !== 'MY_GEMINI_API_KEY');

  if (saved.provider) {
    const p = ALIASES[saved.provider.toLowerCase()] || saved.provider.toLowerCase();
    return {
      provider: p,
      models: Array.isArray(saved.models) && saved.models.length > 0 ? saved.models : [...DEFAULT_GEMINI_MODELS],
      base_url: String(saved.base_url || '').replace(/\/+$/, ''),
      key: typeof saved.key === 'string' && saved.key ? saved.key : p === 'gemini' && hasRealEnvGemini ? envGeminiKey : '',
      saved_here: true,
    };
  }

  if (config.AI_PROVIDER) {
    const p = ALIASES[config.AI_PROVIDER.toLowerCase()] || config.AI_PROVIDER.toLowerCase();
    return {
      provider: p,
      models:
        config.AI_MODELS.length > 0
          ? config.AI_MODELS
          : p === 'gemini'
            ? [...DEFAULT_GEMINI_MODELS]
            : [PROVIDERS[p]?.example || 'gemini-4-hydrogen'],
      base_url: config.AI_BASE_URL.replace(/\/+$/, ''),
      key: config.AI_KEY || (p === 'gemini' && hasRealEnvGemini ? envGeminiKey : ''),
      saved_here: false,
    };
  }

  if (hasRealEnvGemini) {
    return {
      provider: 'gemini',
      models: [...DEFAULT_GEMINI_MODELS],
      base_url: '',
      key: envGeminiKey,
      saved_here: false,
    };
  }

  return {
    provider: '',
    models: [] as string[],
    base_url: '',
    key: '',
    saved_here: false,
  };
}

export function getAiProviderLabel(): string {
  const c = currentAiConfig();
  return PROVIDERS[c.provider]?.label || '';
}

export function isAiReady(): boolean {
  const c = currentAiConfig();
  const def = PROVIDERS[c.provider];
  if (!def || c.models.length === 0) return false;
  const addr = c.base_url || def.address;
  if (!addr) return false;
  return Boolean(c.key || NO_KEY.has(c.provider));
}

export function publicAiConfig() {
  const c = currentAiConfig();
  return {
    provider: c.provider,
    models: c.models,
    base_url: c.base_url,
    has_key: Boolean(c.key),
    key_hint: c.saved_here && c.key.length >= 12 ? c.key.slice(-4) : '',
    ready: isAiReady(),
    label: getAiProviderLabel(),
    saved_here: c.saved_here,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      label: p.label,
      address: p.address,
      needs_key: p.needs_key,
      key_url: p.key_url,
      example: p.example,
    })),
  };
}

export function saveAiConfig(
  providerId: string,
  modelIds: string | string[],
  address = '',
  newKey: string | null = null,
) {
  const rawP = String(providerId || '').trim().toLowerCase();
  const p = ALIASES[rawP] || rawP;
  if (!(p in PROVIDERS)) {
    throw new Error('Choose one of the AI services in the list.');
  }
  const list = Array.isArray(modelIds) ? modelIds : String(modelIds || '').split(',');
  const ms = list
    .map((m) => String(m).trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 5);
  if (ms.length === 0) throw new Error('Enter the model to use.');
  if (ms.some((m) => !/^[\w.\-:/@]+$/.test(m))) {
    throw new Error('A model id has letters, digits and . - : / only.');
  }
  const cleanAddr = String(address || '').trim().replace(/\/+$/, '').slice(0, 300);
  if (cleanAddr && !/^https?:\/\/\S+$/.test(cleanAddr)) {
    throw new Error('The address has to start with http:// or https://');
  }
  if (p === 'custom' && !cleanAddr) {
    throw new Error('A custom service needs its address, for example http://127.0.0.1:1234/v1');
  }
  const old = currentAiConfig();
  const k = newKey === null && old.provider === p ? old.key : String(newKey || '').trim().slice(0, 400);
  if (!k && !NO_KEY.has(p)) {
    throw new Error('Paste the key for this service.');
  }
  config.ensureDirs();
  fs.writeFileSync(AI_FILE, JSON.stringify({ provider: p, models: ms, base_url: cleanAddr, key: k }, null, 2), 'utf-8');
  aiProblem.text = '';
  aiProblem.at = 0;
  aiProblem.transient = false;
  return publicAiConfig();
}

function getGeminiClient(apiKey: string): GoogleGenAI {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

export function isTransientAiError(err: unknown): boolean {
  const low = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    low.includes('503') ||
    low.includes('unavailable') ||
    low.includes('high demand') ||
    low.includes('overloaded') ||
    low.includes('502') ||
    low.includes('504') ||
    low.includes('429') ||
    low.includes('rate limit') ||
    low.includes('temporarily') ||
    low.includes('econnreset') ||
    low.includes('timeout')
  );
}

export function isAuthAiError(err: unknown): boolean {
  const low = String(err instanceof Error ? err.message : err).toLowerCase();
  return (
    low.includes('401') ||
    low.includes('403') ||
    low.includes('api key') ||
    low.includes('api_key') ||
    low.includes('permission_denied')
  );
}

export function buildModelCandidates(configured: string[], provider: string, override?: string): string[] {
  const list: string[] = [];
  if (override) list.push(override);
  for (const m of configured) {
    if (m && !list.includes(m)) list.push(m);
  }
  if (provider === 'gemini') {
    for (const fallback of DEFAULT_GEMINI_MODELS) {
      if (!list.includes(fallback)) list.push(fallback);
    }
  }
  return list;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callSingleModelText(opts: {
  def: ProviderDef;
  key: string;
  baseUrl: string;
  model: string;
  prompt: string;
}): Promise<{ text: string; tokensIn: number; tokensOut: number }> {
  const { def, key, baseUrl, model, prompt } = opts;

  if (def.how === 'gemini') {
    const ai = getGeminiClient(key);
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
      },
    });
    const text = (response.text ?? '').trim();
    const tokensIn = response.usageMetadata?.promptTokenCount ?? Math.ceil(prompt.length / 4);
    const tokensOut = response.usageMetadata?.candidatesTokenCount ?? Math.ceil(text.length / 4);
    return { text, tokensIn, tokensOut };
  }

  if (def.how === 'anthropic') {
    const base = baseUrl || def.address;
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: `${prompt}\n\nRespond with valid JSON only.` }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    return {
      text: body.content?.[0]?.text || '',
      tokensIn: body.usage?.input_tokens ?? 0,
      tokensOut: body.usage?.output_tokens ?? 0,
    };
  }

  const base = baseUrl || def.address;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `${prompt}\n\nRespond with valid JSON only.` }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    text: body.choices?.[0]?.message?.content || '',
    tokensIn: body.usage?.prompt_tokens ?? 0,
    tokensOut: body.usage?.completion_tokens ?? 0,
  };
}

export async function callAiJson(opts: {
  prompt: string;
  uid?: string;
  purpose?: string;
  creator?: string | null;
  place?: string;
  modelOverride?: string;
}): Promise<{ data: unknown; model: string; tokensIn: number; tokensOut: number }> {
  const c = currentAiConfig();
  const def = PROVIDERS[c.provider];
  if (!def || !isAiReady()) {
    throw new Error('No AI service is configured yet.');
  }

  const candidates = buildModelCandidates(c.models, c.provider, opts.modelOverride);
  let lastErr: unknown = new Error('No AI model configured.');

  for (let mIdx = 0; mIdx < candidates.length; mIdx++) {
    const model = candidates[mIdx];
    const maxAttempts = mIdx === 0 ? 2 : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { text, tokensIn, tokensOut } = await callSingleModelText({
          def,
          key: c.key,
          baseUrl: c.base_url,
          model,
          prompt: opts.prompt,
        });
        const data = extractJson(text);

        aiProblem.text = '';
        aiProblem.at = 0;
        aiProblem.transient = false;

        if (opts.uid) {
          recordUsage(opts.uid, tokensIn, tokensOut, opts.purpose || 'ai', opts.creator ?? null, opts.place || '');
        }

        return { data, model, tokensIn, tokensOut };
      } catch (err) {
        lastErr = err;
        if (isAuthAiError(err)) {
          const msg = explainAiError(err);
          aiProblem.text = msg || 'Authentication failed for the configured AI service.';
          aiProblem.at = Date.now() / 1000;
          aiProblem.transient = false;
          throw err;
        }
        if (attempt < maxAttempts && isTransientAiError(err)) {
          await sleep(750);
          continue;
        }
        break;
      }
    }
  }

  const transient = isTransientAiError(lastErr);
  const msg = explainAiError(lastErr);
  aiProblem.text = msg || 'The AI service did not respond. Please try again in a moment.';
  aiProblem.at = Date.now() / 1000;
  aiProblem.transient = transient;
  throw lastErr;
}

export interface TranscriptSegment {
  s: number;
  e: number;
  text: string;
}

/**
 * Checks whether pre-downloaded subtitles genuinely cover the video duration
 * (instead of only having a few words at the start or sparse noise).
 */
export function isSubtitleCoverageAdequate(words: WordStamp[], duration: number): boolean {
  if (!Array.isArray(words) || words.length < 8) return false;
  const dur = Math.max(1, duration);
  if (dur <= 20) return words.length >= 6;
  const first = words[0].s;
  const last = words[words.length - 1].e;
  const span = Math.max(0, Math.min(dur, last) - Math.max(0, first));
  const coverage = span / dur;
  // Require subtitles to span at least 35% of the video AND average at least ~15 words/min
  const wordsPerMin = (words.length / dur) * 60;
  return coverage >= 0.35 && wordsPerMin >= 12;
}

/**
 * Expands chunk-local timestamped speech segments into monotonic WordStamp[]
 * anchored cleanly at `chunkOffset` within `[chunkOffset, chunkOffset + chunkDuration]`.
 */
export function segmentsToWordStamps(
  segments: TranscriptSegment[],
  chunkOffset: number,
  chunkDuration: number,
): WordStamp[] {
  const maxT = chunkOffset + Math.max(0.5, chunkDuration);
  const valid = segments
    .filter((seg) => seg && typeof seg.text === 'string' && seg.text.trim().length > 0)
    .map((seg) => {
      const rawS = Number(seg.s);
      const rawE = Number(seg.e);
      const localS = Number.isFinite(rawS) ? Math.max(0, Math.min(chunkDuration - 0.1, rawS)) : 0;
      const localE = Number.isFinite(rawE) ? Math.max(localS + 0.2, Math.min(chunkDuration, rawE)) : Math.min(chunkDuration, localS + 2.5);
      return { s: chunkOffset + localS, e: chunkOffset + localE, text: seg.text.trim() };
    })
    .sort((a, b) => a.s - b.s);

  const out: WordStamp[] = [];
  let minCursor = chunkOffset;

  for (const seg of valid) {
    const segStart = Math.max(minCursor, seg.s);
    const segEnd = Math.min(maxT, Math.max(segStart + 0.18, seg.e));
    const rawWords = seg.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (rawWords.length === 0) continue;

    const span = Math.max(0.18, segEnd - segStart);
    const totalWeight = rawWords.reduce((sum, w) => sum + Math.max(2, w.length), 0);
    let cursor = segStart;

    for (const w of rawWords) {
      const share = (Math.max(2, w.length) / totalWeight) * span;
      const s = Number(cursor.toFixed(2));
      const e = Number(Math.min(maxT, Math.max(s + 0.08, cursor + share)).toFixed(2));
      out.push({ w, s, e });
      cursor += share;
    }
    minCursor = Math.min(maxT, cursor);
  }

  return out;
}

async function transcribeSingleChunk(opts: {
  ai: GoogleGenAI;
  chunkPath: string;
  chunkOffset: number;
  chunkDuration: number;
  langHint: string;
  uid?: string;
  creator?: string | null;
  place?: string;
}): Promise<WordStamp[]> {
  const stat = fs.statSync(opts.chunkPath);
  if (stat.size === 0 || stat.size > 16 * 1024 * 1024) return [];
  const base64Audio = fs.readFileSync(opts.chunkPath).toString('base64');

  // Pass 1: Structured timestamped speech segments so timestamps match real speech (not smeared across silence)
  const structuredModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
  for (const model of structuredModels) {
    try {
      const response = await opts.ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
            {
              text: `Transcribe ALL spoken words in this ${opts.chunkDuration.toFixed(1)}-second audio clip with accurate timestamps.${opts.langHint}
Return JSON with a "segments" array of short spoken phrases (2 to 12 words each).
Each segment must have:
- s: start time in seconds from the start of THIS audio clip (0.0 to ${opts.chunkDuration.toFixed(1)})
- e: end time in seconds (s < e <= ${opts.chunkDuration.toFixed(1)})
- text: verbatim spoken words in that phrase (skip long silences / pure music).
If there is no speech, return {"segments":[]}.`,
            },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              segments: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    s: { type: Type.NUMBER },
                    e: { type: Type.NUMBER },
                    text: { type: Type.STRING },
                  },
                  required: ['s', 'e', 'text'],
                },
              },
            },
            required: ['segments'],
          },
        },
      });
      const tokensIn = response.usageMetadata?.promptTokenCount ?? Math.ceil(stat.size / 1000);
      const tokensOut = response.usageMetadata?.candidatesTokenCount ?? 120;
      if (opts.uid) {
        recordUsage(opts.uid, tokensIn, tokensOut, 'transcribe', opts.creator ?? null, opts.place || '');
      }
      const parsed = JSON.parse((response.text ?? '{}').trim()) as { segments?: TranscriptSegment[] };
      if (Array.isArray(parsed.segments) && parsed.segments.length > 0) {
        const words = segmentsToWordStamps(parsed.segments, opts.chunkOffset, opts.chunkDuration);
        if (words.length > 0) return words;
      }
      // If model explicitly returned empty segments, try dedicated speech model once to verify
      break;
    } catch (err) {
      if (isAuthAiError(err)) throw err;
      if (isTransientAiError(err)) {
        await sleep(500);
        continue;
      }
    }
  }

  // Pass 2: Fallback to dedicated gemini-3.5-transcribe verbatim transcription anchored strictly to THIS chunk
  const verbatimModels = ['gemini-3.5-transcribe', 'gemini-3.1-flash-lite'];
  for (const model of verbatimModels) {
    try {
      const response = await opts.ai.models.generateContent({
        model,
        contents: {
          parts: [
            { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
            { text: `Transcribe this audio verbatim. Return only the spoken words.${opts.langHint}` },
          ],
        },
      });
      const transcriptText = (response.text ?? '').trim();
      const tokensIn = response.usageMetadata?.promptTokenCount ?? Math.ceil(stat.size / 1000);
      const tokensOut = response.usageMetadata?.candidatesTokenCount ?? Math.ceil(transcriptText.length / 4);
      if (opts.uid) {
        recordUsage(opts.uid, tokensIn, tokensOut, 'transcribe', opts.creator ?? null, opts.place || '');
      }
      if (!transcriptText) return [];
      return distributeWordsOverDuration(transcriptText, opts.chunkDuration, opts.chunkOffset);
    } catch (err) {
      if (isAuthAiError(err)) throw err;
      if (isTransientAiError(err)) {
        await sleep(500);
        continue;
      }
    }
  }

  return [];
}

export async function transcribeAudioWithGemini(opts: {
  audioPath: string;
  duration: number;
  lang?: string;
  uid?: string;
  creator?: string | null;
  place?: string;
  onProgress?: (done: number, total: number) => void;
}): Promise<WordStamp[]> {
  const c = currentAiConfig();
  if (c.provider !== 'gemini' || !c.key) {
    return [];
  }
  if (!fs.existsSync(opts.audioPath) || fs.statSync(opts.audioPath).size === 0) {
    return [];
  }

  const ai = getGeminiClient(c.key);
  const langHint = opts.lang === 'ar' ? ' The audio is in Arabic.' : '';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-tr-'));

  try {
    const chunks = await splitAudioChunks(opts.audioPath, opts.duration, tmpDir, 240);
    if (chunks.length === 0) return [];

    const allWords: WordStamp[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      const chunkWords = await transcribeSingleChunk({
        ai,
        chunkPath: ch.path,
        chunkOffset: ch.start,
        chunkDuration: ch.duration,
        langHint,
        uid: opts.uid,
        creator: opts.creator,
        place: opts.place,
      });
      allWords.push(...chunkWords);
      opts.onProgress?.(i + 1, chunks.length);
    }

    return allWords.sort((a, b) => a.s - b.s);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function distributeWordsOverDuration(transcript: string, duration: number, offset = 0): WordStamp[] {
  const rawWords = transcript
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (rawWords.length === 0) return [];
  const totalDur = Math.max(1, duration);
  const usableDur = Math.max(0.8, totalDur - 0.3);
  const totalWeight = rawWords.reduce((sum, w) => sum + Math.max(2, w.length), 0);
  let cursor = offset + 0.15;
  const maxEnd = offset + totalDur;
  const out: WordStamp[] = [];
  for (const w of rawWords) {
    const share = (Math.max(2, w.length) / totalWeight) * usableDur;
    const s = Number(cursor.toFixed(2));
    const e = Number(Math.min(maxEnd, cursor + Math.max(0.12, share)).toFixed(2));
    out.push({ w, s, e });
    cursor += share;
  }
  return out;
}

export async function listProviderModels(providerId?: string, address?: string, withKey?: string): Promise<string[]> {
  const c = currentAiConfig();
  const rawP = String(providerId || c.provider).toLowerCase();
  const p = ALIASES[rawP] || rawP;
  const def = PROVIDERS[p];
  if (!def) throw new Error('Choose one of the AI services in the list.');
  const k = String(withKey || '').trim() || (c.provider === p ? c.key : '');
  const base = String(address || '').trim().replace(/\/+$/, '') || (c.provider === p ? c.base_url : '') || def.address;
  if (!base) throw new Error("Enter the service's address first.");

  if (def.how === 'gemini') {
    const res = await fetch(`${base}?pageSize=200`, { headers: { 'x-goog-api-key': k } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
    const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const found = (data.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').split('/').pop() || '')
      .filter((id) => id && !/(-tts|-image|imagen-|veo-|lyria-|embedding|^aqa$)/i.test(id));
    return [...new Set(['gemini-4-hydrogen', 'gemini-3.1-flash-lite', ...found])].sort().slice(0, 400);
  }

  const headers: Record<string, string> = {};
  if (def.how === 'anthropic') {
    headers['x-api-key'] = k;
    headers['anthropic-version'] = '2023-06-01';
  } else if (k) {
    headers.Authorization = `Bearer ${k}`;
  }
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  const data = (await res.json()) as { data?: Array<{ id?: string }> };
  return [...new Set((data.data || []).map((m) => String(m.id || '')).filter(Boolean))].sort().slice(0, 400);
}

export async function testAiConnection(uid?: string) {
  if (!isAiReady()) {
    throw new Error('Save a service, a model and a key first.');
  }
  const c = currentAiConfig();
  const { data, model, tokensIn, tokensOut } = await callAiJson({
    prompt: 'Answer with a JSON array that holds the single string "ok".',
    uid,
    purpose: 'test',
    place: 'Settings test',
  });
  return { ok: true, model: model || c.models[0], tokens: tokensIn + tokensOut, answer: JSON.stringify(data).slice(0, 80) };
}

export function explainAiError(err: unknown): string {
  const text = String(err instanceof Error ? err.message : err);
  const low = text.toLowerCase();
  const label = getAiProviderLabel() || 'The AI service';
  const name = currentAiConfig().models[0] || '?';

  if (low.includes('401') || low.includes('403') || low.includes('api key') || low.includes('api_key') || low.includes('permission')) {
    return `${label} refused the key. Check your key in Settings -> AI.`;
  }
  if (low.includes('503') || low.includes('unavailable') || low.includes('high demand') || low.includes('overloaded')) {
    return `${label} is temporarily busy due to high demand. PeakCut will automatically try again on your next video.`;
  }
  if (low.includes('429') || low.includes('quota') || low.includes('rate limit') || low.includes('exhausted')) {
    return `${label} says the key has hit its rate limit or quota. Try again in a moment.`;
  }
  if (low.includes('404') || low.includes('not found') || low.includes('not_found')) {
    return `${label} doesn't know the model "${name}". Open Settings, AI, press Find models and pick an active model.`;
  }
  return '';
}

export function usageBrief(uid: string) {
  const st = getState();
  const now = Date.now() / 1000;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const midnightSec = midnight.getTime() / 1000;

  let todayCalls = 0;
  let todayTokens = 0;
  for (const row of st.usage) {
    if (row.user_id === uid && row.t >= midnightSec) {
      todayCalls += 1;
      todayTokens += row.tokens_in + row.tokens_out;
    }
  }
  const c = currentAiConfig();
  const problemTtl = aiProblem.transient ? 300 : 6 * 3600;
  return {
    ready: isAiReady(),
    provider: getAiProviderLabel(),
    model: c.models[0] || '',
    today_calls: todayCalls,
    today_tokens: todayTokens,
    problem: aiProblem.text && now - aiProblem.at < problemTtl ? aiProblem.text : '',
  };
}

export function usageSummary(uid: string, creatorNames: Record<string, string>) {
  const st = getState();
  const mine = st.usage.filter((r) => r.user_id === uid);
  const now = Date.now() / 1000;
  const fmtDay = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

  let tokensTotal = 0;
  const purposeMap = new Map<string, [number, number]>();
  const creatorMap = new Map<string, [number, number]>();
  const days: string[] = [];
  const dailyMap = new Map<string, [number, number]>();

  for (let i = 29; i >= 0; i--) {
    const d = fmtDay(now - i * 86400);
    days.push(d);
    dailyMap.set(d, [0, 0]);
  }

  for (const r of mine) {
    const tok = r.tokens_in + r.tokens_out;
    tokensTotal += tok;
    const pm = purposeMap.get(r.purpose) ?? [0, 0];
    pm[0] += tok;
    pm[1] += 1;
    purposeMap.set(r.purpose, pm);

    const cname = r.creator ? creatorNames[r.creator] || 'No creator' : 'No creator';
    const cm = creatorMap.get(cname) ?? [0, 0];
    cm[0] += tok;
    cm[1] += 1;
    creatorMap.set(cname, cm);

    const day = fmtDay(r.t);
    const dm = dailyMap.get(day);
    if (dm) {
      dm[0] += tok;
      dm[1] += 1;
    }
  }

  const recent = [...mine]
    .sort((a, b) => b.t - a.t)
    .slice(0, 60)
    .map((r) => ({
      t: r.t,
      tokens: r.tokens_in + r.tokens_out,
      purpose: r.purpose,
      where: r.place,
      creator_name: r.creator ? creatorNames[r.creator] || '' : '',
    }));

  return {
    ...usageBrief(uid),
    calls_total: mine.length,
    tokens_total: tokensTotal,
    daily: days.map((d) => ({ day: d, tokens: dailyMap.get(d)![0], calls: dailyMap.get(d)![1] })),
    by_purpose: [...purposeMap.entries()]
      .map(([k, v]) => [k, v[0], v[1]])
      .sort((a, b) => Number(b[1]) - Number(a[1])),
    by_creator: [...creatorMap.entries()]
      .map(([k, v]) => [k, v[0], v[1]])
      .sort((a, b) => Number(b[1]) - Number(a[1])),
    recent,
  };
}
