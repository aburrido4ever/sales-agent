import Anthropic from '@anthropic-ai/sdk';

/**
 * Browser-direct client for the Claude Messages API.
 *
 * DEMO-ONLY TRADEOFF: the key ships inside the Vite bundle (`dangerouslyAllowBrowser`), exactly
 * like the ElevenLabs key already does in `services.ts`. When `server/` stops being a skeleton,
 * this module is the single place that has to move behind an endpoint — nothing else in the app
 * imports the SDK.
 *
 * Every export here degrades silently: no key, no network, a malformed reply or a refusal all
 * return `undefined`, and every caller in `aisa.ts` falls back to the deterministic path in
 * `services.ts`. The demo must never break because the LLM is unavailable.
 */

const API_KEY = (import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined)?.trim();
const MODEL = (import.meta.env.VITE_ANTHROPIC_MODEL as string | undefined)?.trim() || 'claude-opus-5';

/**
 * `output_config.effort` is rejected with a 400 on the legacy models (Sonnet 4.5, Haiku 4.5) —
 * it only exists from Opus 4.5 / Sonnet 4.6 onward. We send it when the configured model
 * supports it (it is what keeps a spoken turn fast) and simply omit it otherwise, so
 * VITE_ANTHROPIC_MODEL can be pointed at any model without editing code.
 */
const MODELS_WITHOUT_EFFORT = ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-0', 'claude-opus-4-0', 'claude-opus-4-1'];
const supportsEffort = () => !MODELS_WITHOUT_EFFORT.some((model) => MODEL.startsWith(model));

/**
 * Only needed for an ORG-level key. A key created inside a workspace already carries that
 * context and this stays empty; an org-level key is rejected without the header
 * ("This API key is not scoped to a workspace").
 */
const WORKSPACE_ID = (import.meta.env.VITE_ANTHROPIC_WORKSPACE_ID as string | undefined)?.trim();

let cachedClient: Anthropic | undefined;

const getClient = () => {
  if (!API_KEY) return undefined;
  if (!cachedClient) {
    cachedClient = new Anthropic({
      apiKey: API_KEY,
      dangerouslyAllowBrowser: true,
      ...(WORKSPACE_ID ? { defaultHeaders: { 'anthropic-workspace-id': WORKSPACE_ID } } : {}),
    });
  }
  return cachedClient;
};

/** True when a key is configured. Callers branch on this to pick the AI or the mock path. */
export const isAiEnabled = () => Boolean(API_KEY);

export const getAiModel = () => MODEL;

export type JsonSchema = Record<string, unknown>;

type JsonRequest = {
  system: string;
  messages: Anthropic.MessageParam[];
  /** JSON Schema the reply is constrained to, via `output_config.format`. */
  schema: JsonSchema;
  maxTokens?: number;
};

/**
 * One non-streaming turn constrained to `schema`. `effort: 'low'` keeps latency inside what a
 * spoken turn can absorb — AISA is answering out loud while the rep is driving.
 */
export const requestJson = async <T>(request: JsonRequest): Promise<T | undefined> => {
  const client = getClient();
  if (!client) return undefined;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: request.maxTokens ?? 2000,
      system: request.system,
      messages: request.messages,
      output_config: {
        ...(supportsEffort() ? { effort: 'low' as const } : {}),
        format: { type: 'json_schema', schema: request.schema },
      },
    });

    if (response.stop_reason === 'refusal') {
      console.warn('[aisa] model declined the request', response.stop_details);
      return undefined;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!text) return undefined;

    return JSON.parse(text) as T;
  } catch (error) {
    console.warn('[aisa] falling back to the deterministic path:', error);
    return undefined;
  }
};
