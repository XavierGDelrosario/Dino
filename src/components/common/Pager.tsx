// Shared pager: a fixed-size window over an already-in-memory list (no fetch), with
// first/last + a window around the current page and collapsed "…" gaps. Used by the
// Lists surface and the article summary so both page identically. Reuses the
// .listrows__pager* styles (lists.css).
import { useI18n } from "../../i18n";
import { pageWindow } from "../../lib/pagination";
import "../lists/lists.css";

/** Prev · numbered pages · Next. Renders nothing for a single page. */
export function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  const { t } = useI18n();
  if (pageCount <= 1) return null;

  return (
    <nav className="listrows__pager" aria-label={t("lists.pagerAria")}>
      <button
        className="btn btn--sm listrows__pageredge"
        onClick={() => onPage(Math.max(0, page - 1))}
        disabled={page === 0}
      >
        {t("lists.prevPage")}
      </button>
      <div className="listrows__pagenums">
        {pageWindow(page, pageCount).map((p, i) =>
          p === "gap" ? (
            <span key={`gap-${i}`} className="listrows__pagegap">
              …
            </span>
          ) : (
            <button
              key={p}
              className={`btn btn--sm listrows__pagenum${p === page ? " listrows__pagenum--active" : ""}`}
              onClick={() => onPage(p)}
              aria-current={p === page ? "page" : undefined}
              aria-label={t("lists.gotoPage", { n: p + 1 })}
            >
              {p + 1}
            </button>
          ),
        )}
      </div>
      <button
        className="btn btn--sm listrows__pageredge"
        onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
        disabled={page === pageCount - 1}
      >
        {t("lists.nextPage")}
      </button>
    </nav>
  );
}
