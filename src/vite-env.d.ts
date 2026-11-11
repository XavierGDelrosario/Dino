/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Cloudflare Turnstile sitekey (INVISIBLE widget). Unset = captcha off; see services/captcha.ts. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  /** Google OAuth WEB client id. Unset = Google sign-in goes through the Supabase redirect; see services/googleIdentity.ts. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** "1" once the Supabase project's Apple provider is configured; shows the Apple button (AuthPage). */
  readonly VITE_APPLE_SIGNIN?: string;
  /** Base URL for lesson files. Unset = the project's public `lessons` bucket; see services/lessons/source.ts. */
  readonly VITE_LESSONS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
