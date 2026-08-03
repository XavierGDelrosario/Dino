// The ★ that keeps an article. Extracted because it now appears in three places —
// the browse/saved list, the article analysis, and the reading mode — and they have
// to agree on more than the glyph: the same label in both states (so a screen
// reader hears "Remove from saved" rather than "star"), `aria-pressed` so the
// state is announced rather than only drawn, and disabling while the write is in
// flight (the toggle is optimistic, so without this a double-tap fires two writes
// against a row that is mid-flip).
import { useI18n } from "../../i18n";

export interface FavoriteState {
  starred: boolean;
  /** A write is in flight for THIS article — the button disables itself. */
  pending: boolean;
  onToggle: () => void;
}

export function FavoriteStar({
  starred,
  pending,
  onToggle,
  className,
}: FavoriteState & { className?: string }) {
  const { t } = useI18n();
  // One label for title AND aria-label: the glyph alone doesn't say which way the
  // tap goes, and ☆/★ is not a distinction a screen reader conveys.
  const label = t(starred ? "media.unfavorite" : "media.favorite");
  return (
    <button
      type="button"
      className={`media__star${starred ? " media__star--on" : ""}${className ? ` ${className}` : ""}`}
      aria-pressed={starred}
      title={label}
      aria-label={label}
      disabled={pending}
      onClick={onToggle}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}
