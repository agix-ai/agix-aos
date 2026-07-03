// agix-settings — the instance settings store, managed via slash commands (/settings)
// or `agix config`. Persists to ~/.config/agix/settings.json. Settings SAVE here so a
// user configures once and every session/agent reads the same source of truth.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';

const SETTINGS_PATH = resolve(homedir(), '.config/agix/settings.json');

// Known settings + their meaning (shown by `/settings`). Unknown keys are allowed too.
export const KNOWN_SETTINGS = {
  operator_first_name: 'What the mentor calls you',
  operator_email:      'From/signature address (your instances; never in the public pack)',
  default_provider:    'Default LLM provider — anthropic | openai | gemini',
  autonomy:            'ask | proceed — whether agents ask before acting',
  cadence:             'How often standing agents run — daily | weekly | manual',
  tier:                'Entitlement tier (the Agix app sets this) — basic | pro | enterprise',
};

export function loadSettings() {
  try { return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) || {}; } catch { return {}; }
}

export function saveSettings(obj) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  return SETTINGS_PATH;
}

export function getSetting(key, fallback = undefined) {
  const v = loadSettings()[key];
  return v === undefined ? fallback : v;
}

export function setSetting(key, value) {
  const s = loadSettings();
  s[key] = value;
  saveSettings(s);
  return s;
}

export function settingsPath() { return SETTINGS_PATH; }
