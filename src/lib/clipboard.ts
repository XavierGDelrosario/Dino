// Put text on the clipboard. The async Clipboard API where there is one (every modern
// browser, and the iOS app's web view); otherwise the old hidden-textarea route, which
// still works where the page isn't a "secure context". Resolves false instead of
// throwing — a copy button that failed has nothing useful to say beyond not ticking.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked or unavailable — try the fallback */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}
