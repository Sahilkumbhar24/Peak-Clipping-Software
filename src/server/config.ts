import fs from 'node:fs';
import path from 'node:path';

export const ROOT = process.cwd();
export const WEB_DIR = path.join(ROOT, 'web');
export const FONTS_DIR = path.join(ROOT, 'studio', 'fonts');

function envStr(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim();
}

function envBool(name: string, fallback = false): boolean {
  const v = envStr(name).toLowerCase();
  if (!v) return fallback;
  return !['0', 'false', 'no', 'off'].includes(v);
}

function envNum(name: string, fallback: number): number {
  const v = Number(envStr(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const HOST = envStr('PEAKCUT_HOST', '0.0.0.0');
export const PORT = envNum('PORT', envNum('PEAKCUT_PORT', 3000));
export const PUBLIC_URL = envStr('PEAKCUT_PUBLIC_URL') || envStr('APP_URL') || `http://localhost:${PORT}`;
export const HTTPS = PUBLIC_URL.startsWith('https://');
export const ACCOUNTS = envBool('PEAKCUT_ACCOUNTS', false);
export const VERIFY_EMAIL = envBool('PEAKCUT_VERIFY_EMAIL', false);

export const DATA_FROM = envStr('PEAKCUT_DATA') ? 'env' : 'default';
export const DATA_DIR = path.resolve(ROOT, envStr('PEAKCUT_DATA', './data'));
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const MODELS_DIR = path.join(DATA_DIR, 'models');
export const STORAGE_FILE = path.join(ROOT, 'storage.json');
export const YT_COOKIES = path.join(DATA_DIR, 'youtube-cookies.txt');

export const MAX_UPLOAD_MB = envNum('PEAKCUT_MAX_UPLOAD_MB', 500);
export const UPLOAD_PART_MB = envNum('PEAKCUT_UPLOAD_PART_MB', 16);
export const MAX_ACTIVE_JOBS_PER_USER = envNum('PEAKCUT_MAX_ACTIVE_JOBS_PER_USER', 5);
export const MAX_CREATORS = envNum('PEAKCUT_MAX_CREATORS', 50);
export const MAX_USER_GB = envNum('PEAKCUT_MAX_USER_GB', 25);
export const MIN_FREE_DISK_GB = envNum('PEAKCUT_MIN_FREE_DISK_GB', 1);

export const OUT_W = 1080;
export const OUT_H = 1920;
export const OUT_FPS = 30;

export const REPO_URL = 'https://github.com/haziqahmedqasmi/PeakCut';
export const FOLLOW_URL = 'https://github.com/haziqahmedqasmi';
export const CONTACT_EMAIL = envStr('PEAKCUT_CONTACT_EMAIL', '');
export const LEGAL_NAME = envStr('PEAKCUT_LEGAL_NAME', 'PeakCut');
export const LEGAL_COUNTRY = envStr('PEAKCUT_LEGAL_COUNTRY', '');

export const AI_PROVIDER = envStr('PEAKCUT_AI_PROVIDER', '');
export const AI_MODELS = envStr('PEAKCUT_AI_MODELS', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
export const AI_BASE_URL = envStr('PEAKCUT_AI_BASE_URL', '');
export const AI_KEY = envStr('PEAKCUT_AI_KEY', '');

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, TMP_DIR, MODELS_DIR, path.join(DATA_DIR, 'bin'), path.join(TMP_DIR, 'uploads')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function userDir(uid: string): string {
  const safeUid = uid.replace(/[^A-Za-z0-9_-]/g, '_');
  const dir = path.join(DATA_DIR, 'users', safeUid);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
