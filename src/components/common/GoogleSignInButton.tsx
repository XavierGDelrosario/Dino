// Google's OWN "Continue with Google" button (services/googleIdentity). It is an
// iframe Google renders — it cannot be styled, disabled, or triggered from our own
// button — so the auth page shows it only while the form is actionable and swaps in
// its plain button otherwise. Each mount arms a fresh nonce.
import { useEffect, useRef } from "react";
import { mountGoogleButton, type GoogleCredential } from "../../services/googleIdentity";
import { useI18n } from "../../i18n";

export function GoogleSignInButton({
  onCredential,
  onUnavailable,
}: {
  onCredential: (credential: GoogleCredential) => void;
  /** The script could not load (ad-blocker, offline): fall back to the redirect flow. */
  onUnavailable: () => void;
}) {
  const { locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  // Latest handlers without re-mounting the button on every parent render.
  const handlers = useRef({ onCredential, onUnavailable });
  handlers.current = { onCredential, onUnavailable };

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    let active = true;
    const theme = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    mountGoogleButton(el, {
      theme,
      locale,
      cancelled: () => !active,
      onCredential: (credential) => active && handlers.current.onCredential(credential),
    }).catch(() => active && handlers.current.onUnavailable());
    return () => {
      active = false;
      el.replaceChildren();
    };
  }, [locale]);

  return <div ref={container} className="authpage__google" />;
}
