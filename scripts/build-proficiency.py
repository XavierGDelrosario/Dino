#!/usr/bin/env python3
# =========================================================
# Build the PROFICIENCY-band wordlist for the curated proficiency-label axis
# (services/proficiency). One-time / regeneration tooling, like build-frequency.py
# — NOT an app runtime dependency.
#
# For Japanese the framework is JLPT. Source = the per-level CSVs from
# jamsinclair/open-anki-jlpt-decks (MIT; derived from Jonathan Waller's Tanos
# lists), files src/n5.csv … src/n1.csv, columns "expression,reading,meaning,…".
# The FILE is the level (n5.csv → N5). We emit data/proficiency/ja.tsv as
#   "<surface>\t<band>"
# where BAND follows the load-bearing convention ascending = HARDER: N5→1, N4→2,
# N3→3, N2→4, N1→5 (see services/proficiency/framework.ts). The ingest joins this
# onto jmdict_kanji/kana.proficiency_band BY SURFACE, exactly like frequency.
#
# USAGE (no venv needed — stdlib only):
#   # download the 5 level CSVs first, e.g.:
#   #   for n in 1 2 3 4 5; do curl -fsSL \
#   #     https://raw.githubusercontent.com/jamsinclair/open-anki-jlpt-decks/main/src/n$n.csv \
#   #     -o /tmp/jlpt/n$n.csv; done
#   python3 scripts/build-proficiency.py /tmp/jlpt            # -> data/proficiency/ja.tsv
#   python3 scripts/build-proficiency.py /tmp/jlpt --lang ja  # explicit lang
#
# On a surface appearing in more than one level (rare — the Tanos lists are largely
# disjoint) we keep the EASIEST band (the level a learner meets it first). The DATA
# is redistributable under MIT with attribution (see ATTRIBUTION.md); we ship only
# the derived surface→band numbers, one per line.
# =========================================================
from __future__ import annotations

import argparse
import csv
import os
import re
import sys

# JLPT level N -> stored band (ascending = harder). band = 6 - N.
LEVELS = [5, 4, 3, 2, 1]

# The Tanos "expression" field sometimes carries hints/alternates that never match
# a JMdict headword verbatim, e.g. "(花を〜) 生ける, 活ける" or "〜 (まる) ごと".
# Cleaning only COARSENS (strip parenthetical hints + placeholder marks) and SPLITS
# on alternate-form separators — so each result either equals a real surface or
# simply fails to join (never a wrong tag). Deliberately does NOT split on "・"
# (used inside real loanword compounds).
_PARENS = re.compile(r"[（(][^）)]*[）)]")
_PLACEHOLDERS = re.compile(r"[〜～~＝×…\s]")
_SEPARATORS = re.compile(r"[,，、/]")


def clean_surfaces(expression: str) -> list[str]:
    text = _PARENS.sub("", expression)
    out: list[str] = []
    for part in _SEPARATORS.split(text):
        surface = _PLACEHOLDERS.sub("", part)
        if surface:
            out.append(surface)
    return out


def out_path(lang: str) -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", "data", "proficiency", f"{lang}.tsv")


def build(src_dir: str, lang: str) -> None:
    # surface -> smallest band seen (easiest level wins).
    band_of: dict[str, int] = {}
    for n in LEVELS:
        path = os.path.join(src_dir, f"n{n}.csv")
        if not os.path.isfile(path):
            sys.exit(f"missing level file: {path} (expected n1.csv … n5.csv in {src_dir})")
        band = 6 - n  # N5 -> 1 … N1 -> 5
        with open(path, encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if "expression" not in (reader.fieldnames or []):
                sys.exit(f"{path}: no 'expression' column (got {reader.fieldnames})")
            for row in reader:
                for surface in clean_surfaces(row.get("expression") or ""):
                    prev = band_of.get(surface)
                    if prev is None or band < prev:
                        band_of[surface] = band

    dest = out_path(lang)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        for surface in sorted(band_of):
            f.write(f"{surface}\t{band_of[surface]}\n")

    per_band: dict[int, int] = {}
    for b in band_of.values():
        per_band[b] = per_band.get(b, 0) + 1
    print(f"wrote {len(band_of)} surfaces -> {os.path.normpath(dest)}")
    for b in sorted(per_band):
        label = {1: "N5", 2: "N4", 3: "N3", 4: "N2", 5: "N1"}.get(b, str(b))
        print(f"  band {b} ({label}): {per_band[b]}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build data/proficiency/<lang>.tsv from JLPT level CSVs.")
    ap.add_argument("src_dir", help="dir containing n1.csv … n5.csv")
    ap.add_argument("--lang", default="ja", help="language code (default: ja)")
    args = ap.parse_args()
    build(args.src_dir, args.lang)


if __name__ == "__main__":
    main()
