// The multi-select toolbar, shown above the word rows while select mode is on:
// how many are picked · Add to list · Delete (or Remove from list) · Select all OR
// Unselect all.
//
// "Select all" means every word matching the CURRENT filters (all pages of them,
// not just the drawn page). A selection still survives a filter change, so a set can
// be assembled across slices by picking rows — but not by a second "Select all",
// which is gone once anything is picked (below).
// "Unselect all" clears the whole selection, including picks that the current
// filters have hidden — otherwise there'd be no way to reach them.
//
// Only ONE of the two shows at a time, by how many are picked: "Select all" at zero,
// "Unselect all" from the first pick on.
import { useRef, useState } from "react";
import { ListMenu } from "../common/ListMenu";
import { useI18n } from "../../i18n";
import type { List } from "../../services/lists";
import "./lists.css";

export function SelectionBar({
  count,
  visibleCount,
  lists,
  onSelectAll,
  onUnselectAll,
  onAddToList,
  onCreateList,
  remove,
}: {
  /** Total picked — may exceed what's visible under the current filters. */
  count: number;
  /** How many words the current filters show (what "Select all" would add). */
  visibleCount: number;
  lists: List[];
  onSelectAll: () => void;
  onUnselectAll: () => void;
  onAddToList: (listId: string) => void;
  onCreateList: (name: string) => Promise<void>;
  /** The destructive action on the picks. The VIEW decides which one it is — delete
   *  from the vocabulary on ALL, un-tag inside a list — and owns the confirm. */
  remove: { label: string; title: string; danger: boolean; onClick: () => void };
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="listsel">
      <span className="listsel__count">{t("lists.selectedCount", { n: count })}</span>

      <div className="listsel__actions">
        {/* Add to list appears only once something is picked — it's the payoff of the
            selection, and an always-present dead button would just be noise. */}
        {count > 0 && (
          <>
            <button
              ref={addBtnRef}
              className="btn btn--sm btn--primary"
              onClick={() => setMenu(true)}
              title={t("lists.addSelectedTitle", { n: count })}
            >
              {t("lists.addSelectedToList")}
            </button>
            {menu && (
              <ListMenu
                anchorRef={addBtnRef}
                lists={lists}
                title={t("lists.addSelectedTitle", { n: count })}
                onPick={(listId) => {
                  onAddToList(listId);
                  setMenu(false);
                }}
                onCreate={(name) => onCreateList(name).then(() => setMenu(false))}
                onClose={() => setMenu(false)}
              />
            )}
            <button
              className={`btn btn--sm${remove.danger ? " btn--danger" : ""}`}
              onClick={remove.onClick}
              title={remove.title}
            >
              {remove.label}
            </button>
          </>
        )}

        {count > 0 ? (
          <button className="btn btn--sm" onClick={onUnselectAll}>
            {t("lists.unselectAll")}
          </button>
        ) : (
          <button className="btn btn--sm" onClick={onSelectAll} disabled={visibleCount === 0}>
            {t("lists.selectAll")}
          </button>
        )}
      </div>
    </div>
  );
}
