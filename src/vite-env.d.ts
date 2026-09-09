/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ElevenLabs API key for natural-voice TTS (demo-only, client-exposed — see RQ-12 §4). */
  readonly VITE_ELEVENLABS_API_KEY?: string;
  /** ElevenLabs voice id; falls back to the public "Rachel" voice when unset. */
  readonly VITE_ELEVENLABS_VOICE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
