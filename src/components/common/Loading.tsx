import { NoFooter } from "./NoFooter";

// The app's loading affordances: an animated "..." — standing alone (a busy button)
// or trailing a message ("Translating" + dots) — and, for anything that fills a page
// or a section, the MASCOT with the dots (PageLoading), the same look as the splash.
//
// Message strings in the catalog keep their "…" so they still read right anywhere
// they're shown as plain text; <Loading> swaps that static ellipsis for the animated
// one, so the dots are never doubled up.

/** Three dots that pulse in turn. Fixed width, so the text beside it never jitters. */
export function LoadingDots() {
  return (
    <span className="loading-dots">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

const TRAILING_ELLIPSIS = /\s*(…|\.{3})$/u;

/** A loading message with its trailing ellipsis animated. */
export function Loading({ text }: { text: string }) {
  return (
    <>
      {text.replace(TRAILING_ELLIPSIS, "")}
      <LoadingDots />
    </>
  );
}

/** Startup: just the mascot, centred, with the dots under it — no header, no chrome.
 *  index.html carries the same markup inside #root so the first paint already shows
 *  it and React mounting over it is seamless; keep the two in step. */
export function SplashScreen() {
  return (
    <div className="splash" role="status" aria-label="Loading">
      <img className="splash__icon" src="/dino-icon.png" alt="" />
      <LoadingDots />
    </div>
  );
}

/**
 * A page or section that is loading: the mascot, an optional message, the dots — the
 * splash in miniature, so every wait in the app looks like the one at startup instead
 * of a bare line of grey text.
 *
 * It also hides the legal/credits footer while it is up (NoFooter). Without that, a
 * page whose body was still empty — History before its data landed rendered nothing at
 * all — showed ONLY "Privacy · Terms · Support" and the data credits, which read as the
 * app having opened the wrong page.
 *
 * `inline`: a loader inside a tab section (Lists, Learn, Articles) — smaller, and no
 * minimum height, so the section's own controls above it don't jump.
 */
export function PageLoading({ text, inline = false }: { text?: string; inline?: boolean }) {
  const label = text?.replace(TRAILING_ELLIPSIS, "");
  return (
    <div className={`pageloading${inline ? " pageloading--inline" : ""}`} role="status" aria-label={label || "Loading"}>
      <NoFooter />
      <img className="pageloading__icon" src="/dino-icon.png" alt="" />
      {label && <p className="pageloading__text">{label}</p>}
      <LoadingDots />
    </div>
  );
}
