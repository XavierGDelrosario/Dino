// The multi-select toolbar, shown above the word rows while select mode is on:
// how many are picked · Select all / Unselect all · Add to list.
//
// "Select all" means every word matching the CURRENT filters (all pages of them,
// not just the drawn page) — it adds to the selection rather than replacing it,
// because a selection deliberately survives a filter change: filter, select all,
// re-filter, select all again is how you assemble a set out of several slices.
// "Unselect all" clears the whole selection, including picks that the current
// filters have hidden — otherwise there'd be no way to reach them.
import { useRef, useState } from "react";
import { ListMenu } from "../common/ListMenu";
import { useI18n } from "../../i18n";
import type { List } from "../../services/lists";
import "./lists.css";

export function SelectionBar({
  count,
  visibleCount,
  allVisibleSelected,
  lists,
  onSelectAll,
  onUnselectAll,
  onAddToList,
  onCreateList,
}: {
  /** Total picked — may exceed what's visible under the current filters. */
  count: number;
  /** How many words the current filters show (what "Select all" would add). */
  visibleCount: number;
  allVisibleSelected: boolean;
  lists: List[];
  onSelectAll: () => void;
  onUnselectAll: () => void;
  onAddToList: (listId: string) => void;
  onCreateList: (name: string) => Promise<void>;
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
          </>
        )}

        <button
          className="btn btn--sm"
          onClick={onSelectAll}
          disabled={visibleCount === 0 || allVisibleSelected}
        >
          {t("lists.selectAll")}
        </button>
        <button className="btn btn--sm" onClick={onUnselectAll} disabled={count === 0}>
          {t("lists.unselectAll")}
        </button>
      </div>
    </div>
  );
}
