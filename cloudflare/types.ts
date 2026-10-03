export interface Env {
  DB: D1Database;
  MEMORY: R2Bucket;
  ASSETS: Fetcher;
  GEMINI_API_KEY: string;
  PASSKEY_RP_ID: string;
  PASSKEY_ORIGIN: string;
  HARNESS_MODEL?: string;
}

export type User = { id: string; name: string; email: string };
