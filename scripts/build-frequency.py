#!/usr/bin/env python3
# =========================================================
# Build a derived word-frequency file from wordfreq (one-time tooling).
#
# wordfreq (https://github.com/rspeer/wordfreq) is the source of DINO's DIFFICULTY
# AXIS (corpus frequency). Its DATA is CC-BY-SA 4.0, so the file this emits is a
# derivative we redistribute under CC-BY-SA with attribution (see NOTICE). We ship
# only the derived numbers (a normalized Zipf score per surface), never the corpus.
#
# Output: data/frequency/<lang>.tsv  —  "<surface>\t<zipf×100>" per line, where
#   zipf = log10(frequency per billion words)  (≈1 rare … ≈8 ubiquitous),
# stored as an INT (zipf×100, higher = MORE common). The jmdict ingest joins this
# onto dictionary headwords by surface; getDifficulty bins it into 1..5.
#
# Why Zipf: it's a NORMALIZED, log-scaled, cross-language-comparable measure, so
# the same difficulty thresholds work across JA/KO/ZH (the universal level scale).
# It's also a transform of facts (frequencies), not a copy of any source list.
#
# USAGE (regeneration only — NOT an app/runtime dependency, like the JMdict pull):
#   python3 -m venv /tmp/wfvenv
#   /tmp/wfvenv/bin/pip install -r scripts/requirements-frequency.txt
#   /tmp/wfvenv/bin/python scripts/build-frequency.py ja
#   (wordfreq's 'large' list is used for coverage; MeCab is NOT needed — we read
#    the stored per-token dict directly, no query tokenization.)
# =========================================================
import math
import os
import sys
import unicodedata

import wordfreq


def main() -> None:
    lang = sys.argv[1] if len(sys.argv) > 1 else "ja"
    if lang not in wordfreq.available_languages():
        sys.exit(f"wordfreq has no data for language '{lang}'")

    # The stored per-token frequencies (proportions). 'large' maximizes coverage so
    # more dictionary words get a score; rare words simply land at a low (hard) zipf.
    freqs = wordfreq.get_frequency_dict(lang, wordlist="large")

    out_dir = os.path.join(os.path.dirname(__file__), "..", "data", "frequency")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"{lang}.tsv")

    n = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for surface, freq in freqs.items():
            if freq <= 0:
                continue
            # NFC so keys match DINO's normalized dictionary headwords.
            key = unicodedata.normalize("NFC", surface)
            zipf = math.log10(freq) + 9.0  # proportion → per-billion → log10
            f.write(f"{key}\t{round(zipf * 100)}\n")
            n += 1

    print(f"Wrote {n} {lang} frequencies → {os.path.relpath(out_path)}")


if __name__ == "__main__":
    main()
