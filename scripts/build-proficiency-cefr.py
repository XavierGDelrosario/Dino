#!/usr/bin/env python3
# =========================================================
# Build the CEFR (English) proficiency wordlist → data/proficiency/en.tsv.
# The English counterpart of build-proficiency.py (which is JLPT-specific: one CSV
# per level). CEFR-J publishes ONE CSV with a `CEFR` column, so this reads that shape.
#
# Source (openlanguageprofiles/olp-en-cefrj):
#   - cefrj-vocabulary-profile-*.csv   (A1–B2, © Tono Lab/TUFS — free research+commercial w/ citation)
#   - octanove-vocabulary-profile-*.csv (C1–C2, CC BY-SA 4.0)
#   CSV columns: headword,pos,CEFR,...  — we use headword + CEFR only.
#
# Emits data/proficiency/en.tsv as "<surface>\t<band>" with BAND ascending = HARDER:
#   A1→1 A2→2 B1→3 B2→4 C1→5 C2→6  (services/proficiency CEFR = bandsFromLabels(A1..C2)).
# On a surface at multiple levels (different POS rows) we keep the EASIEST band (the
# level a learner meets it first), matching build-proficiency.py. Surfaces are
# lowercased + NFC so they match the edge's english_proficiency lookup (lower(input)),
# same as data/frequency/en.tsv. Alternate forms ("a.m./A.M./am/AM") are split on "/".
# We ship only the derived numbers, never the source CSVs. See ATTRIBUTION.md.
#
# USAGE (stdlib only, no venv):
#   mkdir -p /tmp/cefr && for f in cefrj-vocabulary-profile-1.5.csv octanove-vocabulary-profile-c1c2-1.0.csv; do \
#     curl -fsSL "https://raw.githubusercontent.com/openlanguageprofiles/olp-en-cefrj/master/$f" -o /tmp/cefr/$f; done
#   python3 scripts/build-proficiency-cefr.py /tmp/cefr
# =========================================================
import csv
import os
import re
import sys
import unicodedata

BAND = {"A1": 1, "A2": 2, "B1": 3, "B2": 4, "C1": 5, "C2": 6}


def clean(headword: str) -> str:
    return re.sub(r"\([^)]*\)", "", headword).strip()  # strip parenthetical hints


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cefr"
    csvs = [f for f in sorted(os.listdir(src)) if f.endswith(".csv")]
    if not csvs:
        sys.exit(f"no CSV files in {src}")

    best: dict[str, int] = {}  # surface -> easiest (lowest) band
    for fn in csvs:
        with open(os.path.join(src, fn), encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                band = BAND.get((row.get("CEFR") or "").strip().upper())
                if not band:
                    continue
                for form in clean(row.get("headword") or "").split("/"):
                    key = unicodedata.normalize("NFC", form.strip().lower())
                    if not key:
                        continue
                    if key not in best or band < best[key]:
                        best[key] = band

    out = os.path.join(os.path.dirname(__file__), "..", "data", "proficiency", "en.tsv")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for surface in sorted(best):
            f.write(f"{surface}\t{best[surface]}\n")
    print(f"Wrote {len(best)} CEFR surfaces → {os.path.relpath(out)} (from {', '.join(csvs)})")


if __name__ == "__main__":
    main()
