// The app's one loading affordance: an animated "..." — standing alone (a busy
// button, the splash) or trailing a message ("Translating" + dots).
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
