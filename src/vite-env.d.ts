/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Cloudflare Turnstile sitekey (INVISIBLE widget). Unset = captcha off; see services/captcha.ts. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** Google OAuth WEB client id. Unset = Google sign-in goes through the Supabase redirect; see services/googleIdentity.ts. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
