// The Lists screen: a row of list chips (ALL + sub-lists + New), the words in
// the selected list, and forms to create a sub-list / add a custom word.
//
// "ALL" is the virtual whole-vocabulary view (not a stored list). Adding a
// custom word while a sub-list is selected also tags it into that sub-list.
import { useMemo, useState } from "react";
import { useLists } from "../hooks/useLists";
import { ListRow } from "../components/lists/ListRow";
import {
  sourceOptions,
  targetOptions,
  AUTO_DETECT,
  type LangCode,
  type SourceSelection,
} from "../services/language";
import type { UserWord } from "../services/words/userWords";
import type { Word } from "../services/words/repository";
import "../components/lists/lists.css";

type SortBy = "newest" | "oldest" | "conf-asc" | "conf-desc";
type DatePeriod = "all" | "today" | "week" | "month" | "year";

const langName = (code: string) =>
  targetOptions().find((o) => o.code === code)?.name ?? code;

/** Earliest timestamp included by a calendar-period filter ("today"=since
 *  midnight, "week"=since Monday, "month"=since the 1st, "year"=since Jan 1). */
function periodCutoff(period: DatePeriod): number {
  if (period === "all") return -Infinity;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (period === "month") d.setDate(1);
  else if (period === "year") d.setMonth(0, 1);
  return d.getTime();
}

export function ListView({
  userId,
  onReview,
}: {
  userId: string;
  onReview: (listId: string | null, name: string) => void;
}) {
  const L = useLists(userId);
  const selectedList = L.lists.find((l) => l.listId === L.selectedListId) ?? null;

  const [sort, setSort] = useState<SortBy>("newest");
  const [langFilter, setLangFilter] = useState<LangCode | "all">("all");
  const [addedFilter, setAddedFilter] = useState<DatePeriod>("all");
  const [reviewedFilter, setReviewedFilter] = useState<DatePeriod>("all");
  const [confMin, setConfMin] = useState(0);
  const [confMax, setConfMax] = useState(5);

  // input languages actually present in the current list (for the filter)
  const langsPresent = useMemo(
    () => [...new Set(L.words.map((w) => w.sourceLang))].sort(),
    [L.words]
  );

  const visible = useMemo(() => {
    const byDate = (a: UserWord, b: UserWord) =>
      Date.parse(a.originallyTranslatedDate) - Date.parse(b.originallyTranslatedDate);
    const byConf = (a: UserWord, b: UserWord) => a.confidenceRating - b.confidenceRating;

    const addedCut = periodCutoff(addedFilter);
    const reviewedCut = periodCutoff(reviewedFilter);

    const ws = L.words.filter(
      (w) =>
        (langFilter === "all" || w.sourceLang === langFilter) &&
        Date.parse(w.originallyTranslatedDate) >= addedCut &&
        // a reviewed-date filter excludes never-reviewed words
        (reviewedFilter === "all" ||
          (w.lastReviewedDate != null && Date.parse(w.lastReviewedDate) >= reviewedCut)) &&
        w.confidenceRating >= confMin &&
        w.confidenceRating <= confMax
    );

    const sorted = [...ws];
    switch (sort) {
      case "newest": sorted.sort((a, b) => byDate(b, a)); break;
      case "oldest": sorted.sort(byDate); break;
      // confidence ties break on most-recently-added
      case "conf-asc": sorted.sort((a, b) => byConf(a, b) || byDate(b, a)); break;
      case "conf-desc": sorted.sort((a, b) => byConf(b, a) || byDate(b, a)); break;
    }
    return sorted;
  }, [L.words, langFilter, sort, addedFilter, reviewedFilter, confMin, confMax]);

  return (
    <section className="lists">
      <ListChips
        lists={L.lists}
        selectedListId={L.selectedListId}
        onSelect={L.setSelectedListId}
        onCreate={L.addList}
      />

      <div className="lists__bar">
        <h2 className="lists__title">
          {selectedList ? selectedList.listName : "All words"}
          <span className="lists__count">{visible.length}</span>
        </h2>
        {L.words.length > 0 && (
          <button
            className="btn btn--sm lists__reviewbtn"
            onClick={() =>
              onReview(L.selectedListId, selectedList ? selectedList.listName : "All words")
            }
            title="Review this list with flashcards"
          >
            ▶ Review
          </button>
        )}
        {selectedList && (
          <button
            className="btn btn--sm btn--danger lists__deletebtn"
            onClick={() => {
              if (confirm(`Delete the list "${selectedList.listName}"? Words stay in your vocabulary.`))
                L.deleteListById(selectedList.listId);
            }}
            title="Delete this sub-list"
          >
            Delete list
          </button>
        )}
      </div>

      <div className="lists__toolbar">
        <AddWord lookup={L.lookupDictionary} onSave={L.saveSenseToList} />
        <AddCustomWord onAdd={L.addCustomWord} />

        {L.status === "ready" && L.words.length > 0 && (
          <div className="lists__controls">
            <select
              className="select select--sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as SortBy)}
              aria-label="Sort words"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="conf-asc">Confidence: low → high</option>
              <option value="conf-desc">Confidence: high → low</option>
            </select>

            {langsPresent.length > 1 && (
              <select
                className="select select--sm"
                value={langFilter}
                onChange={(e) => setLangFilter(e.target.value as LangCode | "all")}
                aria-label="Filter by input language"
              >
                <option value="all">All languages</option>
                {langsPresent.map((code) => (
                  <option key={code} value={code}>
                    {langName(code)}
                  </option>
                ))}
              </select>
            )}

            <PeriodSelect
              label="Added"
              value={addedFilter}
              onChange={setAddedFilter}
              ariaLabel="Filter by date added"
            />
            <PeriodSelect
              label="Reviewed"
              value={reviewedFilter}
              onChange={setReviewedFilter}
              ariaLabel="Filter by date last reviewed"
            />

            <div className="confrange" title="Filter by confidence range">
              <span className="confrange__label">
                Confidence {confMin}–{confMax}
              </span>
              {/* dual-thumb range: two inputs overlaid on one track */}
              <div className="dualrange">
                <div className="dualrange__track" />
                <div
                  className="dualrange__fill"
                  style={{
                    left: `${(confMin / 5) * 100}%`,
                    right: `${((5 - confMax) / 5) * 100}%`,
                  }}
                />
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMin}
                  onChange={(e) => setConfMin(Math.min(Number(e.target.value), confMax))}
                  aria-label="Minimum confidence"
                />
                <input
                  type="range"
                  className="dualrange__input"
                  min={0}
                  max={5}
                  value={confMax}
                  onChange={(e) => setConfMax(Math.max(Number(e.target.value), confMin))}
                  aria-label="Maximum confidence"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {L.error && <pre className="review__error">{L.error}</pre>}

      {L.status === "loading" && <p className="review__msg">Loading…</p>}

      {L.status === "ready" && L.words.length === 0 && (
        <p className="review__msg">
          {selectedList
            ? "No words tagged into this list yet."
            : "No words yet — translate some, or add a custom one above."}
        </p>
      )}

      {L.status === "ready" && L.words.length > 0 && visible.length === 0 && (
        <p className="review__msg">No words match this filter.</p>
      )}

      {L.status === "ready" && visible.length > 0 && (
        <ul className="listrows">
          {visible.map((w) => (
            <ListRow
              key={w.userWordId}
              word={w}
              lists={L.lists}
              onEdit={(translation) => L.editWord(w.userWordId, translation)}
              onDelete={() => L.deleteWord(w.userWordId)}
              onTag={(listId) => L.tagWord(w.userWordId, listId)}
              onRemoveFromList={
                L.selectedListId ? () => L.untagWord(w.userWordId) : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function PeriodSelect({
  label,
  value,
  onChange,
  ariaLabel,
}: {
  label: string;
  value: DatePeriod;
  onChange: (v: DatePeriod) => void;
  ariaLabel: string;
}) {
  return (
    <select
      className="select select--sm"
      value={value}
      onChange={(e) => onChange(e.target.value as DatePeriod)}
      aria-label={ariaLabel}
    >
      <option value="all">{label}: all time</option>
      <option value="today">{label}: today</option>
      <option value="week">{label}: this week</option>
      <option value="month">{label}: this month</option>
      <option value="year">{label}: this year</option>
    </select>
  );
}

function ListChips({
  lists,
  selectedListId,
  onSelect,
  onCreate,
}: {
  lists: { listId: string; listName: string }[];
  selectedListId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  return (
    <div className="chips">
      <button
        className={`chip${selectedListId === null ? " chip--active" : ""}`}
        onClick={() => onSelect(null)}
      >
        ALL
      </button>
      {lists.map((l) => (
        <button
          key={l.listId}
          className={`chip${selectedListId === l.listId ? " chip--active" : ""}`}
          onClick={() => onSelect(l.listId)}
        >
          {l.listName}
        </button>
      ))}

      {creating ? (
        <span className="chips__new">
          <input
            className="input input--sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="List name"
            aria-label="New list name"
            autoFocus
          />
          <button
            className="iconbtn"
            onClick={() => {
              const v = name.trim();
              if (v) onCreate(v);
              setName("");
              setCreating(false);
            }}
            title="Create"
          >
            ✓
          </button>
          <button
            className="iconbtn"
            onClick={() => {
              setName("");
              setCreating(false);
            }}
            title="Cancel"
          >
            ✕
          </button>
        </span>
      ) : (
        <button className="chip chip--ghost" onClick={() => setCreating(true)}>
          ＋ New list
        </button>
      )}
    </div>
  );
}

/** Look up a word in the dictionary and add it to the current list — the meaning
 *  comes from the dictionary, not typed. AUTO-ADDS the primary sense, shows what
 *  it picked, and offers the other meanings (in case the primary was wrong). */
function AddWord({
  lookup,
  onSave,
}: {
  lookup: (p: {
    input: string;
    sourceLang: SourceSelection;
    targetLang: LangCode;
  }) => Promise<{ input: string; meanings: Word[] }>;
  onSave: (word: Word) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sourceLang, setSourceLang] = useState<SourceSelection>(AUTO_DETECT);
  const [targetLang, setTargetLang] = useState<LangCode>("EN");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ input: string; meanings: Word[] } | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [showOthers, setShowOthers] = useState(false);

  const reset = () => {
    setResult(null);
    setSaved(new Set());
    setShowOthers(false);
    setErr(null);
  };

  if (!open) {
    return (
      <button className="btn lists__addtoggle" onClick={() => setOpen(true)}>
        ＋ Add word
      </button>
    );
  }

  // Look up, then auto-add the primary sense.
  const submit = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    reset();
    try {
      const r = await lookup({ input, sourceLang, targetLang });
      if (r.meanings.length === 0) {
        setErr(`No dictionary match for "${r.input}".`);
        return;
      }
      setResult(r);
      await onSave(r.meanings[0]); // auto-add primary
      setSaved(new Set([r.meanings[0].wordId]));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addOther = async (w: Word) => {
    if (saved.has(w.wordId)) return;
    try {
      await onSave(w);
      setSaved((s) => new Set(s).add(w.wordId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const primary = result?.meanings[0];
  const others = result?.meanings.slice(1) ?? [];

  return (
    <div className="addword addword--lookup">
      <div className="addword__row">
        <div className="addword__langs">
          <select
            className="select select--sm"
            value={sourceLang}
            onChange={(e) => setSourceLang(e.target.value)}
            aria-label="Word language"
          >
            {sourceOptions().map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
          <span className="langbar__arrow">→</span>
          <select
            className="select select--sm"
            value={targetLang}
            onChange={(e) => setTargetLang(e.target.value as LangCode)}
            aria-label="Meaning language"
          >
            {targetOptions().map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <input
          className="input input--sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Word"
          aria-label="Word to look up"
        />
        <button className="btn" onClick={submit} disabled={!input.trim() || busy}>
          {busy ? "…" : "Add"}
        </button>
        <button
          className="iconbtn"
          onClick={() => {
            setOpen(false);
            setInput("");
            reset();
          }}
          title="Close"
        >
          ✕
        </button>
      </div>

      {err && <pre className="review__error">{err}</pre>}

      {primary && (
        <div className="addword__result">
          <div className="addword__added">
            ✓ Added <span className="addword__head">{primary.input}</span>
            {primary.inputReading && <em className="result__reading">{primary.inputReading}</em>}
            {" → "}
            {primary.translation}
          </div>

          {others.length > 0 && (
            <>
              <button className="results__more" onClick={() => setShowOthers((v) => !v)}>
                {showOthers ? "Hide other meanings" : `Other meanings (${others.length})`}
              </button>
              {showOthers && (
                <ul className="addword__others">
                  {others.map((w) => (
                    <li key={w.wordId} className="sense">
                      <span className="sense__text">
                        <span className="addword__head">{w.input}</span>
                        {w.inputReading && ` ${w.inputReading}`} → {w.translation}
                      </span>
                      <button
                        className={`sense__add${saved.has(w.wordId) ? " sense__saved" : ""}`}
                        onClick={() => addOther(w)}
                        disabled={saved.has(w.wordId)}
                      >
                        {saved.has(w.wordId) ? "✓" : "＋"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AddCustomWord({
  onAdd,
}: {
  onAdd: (p: {
    input: string;
    translation: string;
    sourceLang: LangCode;
    targetLang: LangCode;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [translation, setTranslation] = useState("");
  const [sourceLang, setSourceLang] = useState<LangCode>("JA");
  const [targetLang, setTargetLang] = useState<LangCode>("EN");

  if (!open) {
    return (
      <button className="btn lists__addtoggle" onClick={() => setOpen(true)}>
        ＋ Add custom word
      </button>
    );
  }

  const submit = () => {
    if (!input.trim() || !translation.trim()) return;
    onAdd({ input, translation, sourceLang, targetLang });
    setInput("");
    setTranslation("");
    setOpen(false);
  };

  return (
    <div className="addword">
      <div className="addword__langs">
        <select
          className="select select--sm"
          value={sourceLang}
          onChange={(e) => setSourceLang(e.target.value as LangCode)}
          aria-label="Word language"
        >
          {targetOptions().map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="langbar__arrow">→</span>
        <select
          className="select select--sm"
          value={targetLang}
          onChange={(e) => setTargetLang(e.target.value as LangCode)}
          aria-label="Meaning language"
        >
          {targetOptions().map((o) => (
            <option key={o.code} value={o.code}>
              {o.name}
            </option>
          ))}
        </select>
      </div>
      <input
        className="input input--sm"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="Word"
        aria-label="Custom word"
      />
      <input
        className="input input--sm"
        value={translation}
        onChange={(e) => setTranslation(e.target.value)}
        placeholder="Meaning"
        aria-label="Custom meaning"
      />
      <button className="btn" onClick={submit} disabled={!input.trim() || !translation.trim()}>
        Add
      </button>
      <button className="iconbtn" onClick={() => setOpen(false)} title="Cancel">
        ✕
      </button>
    </div>
  );
}
