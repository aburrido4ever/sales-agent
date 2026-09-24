/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ElevenLabs API key for natural-voice TTS (demo-only, client-exposed — see RQ-12 §4). */
  readonly VITE_ELEVENLABS_API_KEY?: string;
  /** ElevenLabs voice id; falls back to the public "Rachel" voice when unset. */
  readonly VITE_ELEVENLABS_VOICE_ID?: string;
  /** Anthropic API key for the AISA LLM (demo-only, client-exposed — see src/ai/client.ts). */
  readonly VITE_ANTHROPIC_API_KEY?: string;
  /** Overrides the Claude model AISA runs on; defaults to `claude-opus-5`. */
  readonly VITE_ANTHROPIC_MODEL?: string;
  /** Required only when the API key is org-level rather than scoped to a workspace. */
  readonly VITE_ANTHROPIC_WORKSPACE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
