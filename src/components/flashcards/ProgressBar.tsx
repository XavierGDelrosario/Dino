// Position through the current review queue. `position` is 1-based (the card
// being shown); the fill reflects how many cards are already behind it.
import "./flashcards.css";

export function ProgressBar({
  position,
  total,
}: {
  position: number;
  total: number;
}) {
  const done = Math.max(0, position - 1);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress__track">
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress__label">
        {position} / {total}
      </span>
    </div>
  );
}
