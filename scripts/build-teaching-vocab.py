#!/usr/bin/env python3
# =========================================================
# Build data/teaching_vocab/ja.tsv — every surface that appears in ANY of the six
# Japanese-as-a-foreign-language teaching vocabulary lists NINJAL compares in
# 日本語教育基本語彙データベース (rokusyutaisyo.csv: 国語研 1984, 初級500語, 七種対照,
# 工藤, 木幡, 玉村). CC BY 4.0, National Institute for Japanese Language and
# Linguistics — https://mmsrv.ninjal.ac.jp/brfvep/ (attribution in ATTRIBUTION.md).
#
# Used ONLY as an input to the level ESTIMATE (scripts/apply-level-estimates.ts): a word
# on none of these lists is far more likely advanced — among JLPT-listed kanji compounds
# at Zipf 3.5–5.0, 63% of the off-list ones are N1 vs 30% of the listed ones
# (docs/research/Level_Estimate_Gap_Fill.md). One surface per line; both the written
# form (表記) and the kana headword (見出し) are kept.
#
# USAGE (stdlib only):
#   curl -fsSLO https://mmsrv.ninjal.ac.jp/brfvep/rokusyutaisyo.csv
#   python3 scripts/build-teaching-vocab.py rokusyutaisyo.csv
# =========================================================
import csv, io, os, re, sys, unicodedata

LISTS = ["国語研", "初級500語", "七種対照", "工藤", "木幡", "玉村"]
# The lists also carry romanized names ("Africa") that can never match a JMdict writing.
JAPANESE = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff々]")

def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: build-teaching-vocab.py <rokusyutaisyo.csv>")
    surfaces: set[str] = set()
    with io.open(sys.argv[1], encoding="cp932") as f:       # the NINJAL file is Shift-JIS
        for row in csv.DictReader(f):
            if not any((row.get(k) or "").strip() in ("○", "◎") for k in LISTS):
                continue
            for s in ((row.get("表記") or "").strip(), (row.get("見出し") or "").strip()):
                if s and JAPANESE.search(s):
                    surfaces.add(unicodedata.normalize("NFC", s))
    dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "teaching_vocab", "ja.tsv")
    with open(dest, "w", encoding="utf-8") as out:
        out.write("# Surfaces on any of NINJAL's six JFL teaching vocabulary lists (CC BY 4.0).\n")
        out.write("# Built by scripts/build-teaching-vocab.py — see ATTRIBUTION.md.\n")
        for s in sorted(surfaces):
            out.write(s + "\n")
    print(f"wrote {len(surfaces)} surfaces -> {os.path.normpath(dest)}")

if __name__ == "__main__":
    main()
