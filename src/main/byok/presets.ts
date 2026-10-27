/**
 * byok/presets.ts — v0.21 "Your own AI model" (BYOK) provider presets.
 *
 * Pure data, no Electron. `api` picks the wire adapter in adapters.ts:
 * every preset except Anthropic and Gemini speaks OpenAI chat/completions.
 */

export type ByokApi = 'openai' | 'anthropic' | 'gemini';

export interface ProviderPreset {
  id: string;
  label: string;
  api: ByokApi;
  baseUrl: string;
  defaultModel: string;
  /** false for local servers (Ollama, LM Studio) — no key needed. */
  needsKey: boolean;
  keyUrl?: string;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  { id: 'openai', label: 'OpenAI', api: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.4-mini', needsKey: true, keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5', needsKey: true, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', label: 'Google Gemini', api: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', defaultModel: 'gemini-2.5-flash', needsKey: true, keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'deepseek', label: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-v4-flash', needsKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', label: 'OpenRouter', api: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-5.4-mini', needsKey: true, keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', needsKey: true, keyUrl: 'https://console.groq.com/keys' },
  { id: 'ollama', label: 'Ollama (local)', api: 'openai', baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:7b', needsKey: false },
  { id: 'lmstudio', label: 'LM Studio (local)', api: 'openai', baseUrl: 'http://localhost:1234/v1', defaultModel: 'local-model', needsKey: false },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', api: 'openai', baseUrl: '', defaultModel: '', needsKey: false },
]);

export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}
