#!/usr/bin/env python3
# =========================================================
# Build word embeddings for the relatedness / "word map" axis (#11).
#
# One-time / regeneration tooling, like the JMdict + frequency ingest — NOT an
# app/runtime dependency. Embeds each JMdict entry's "<writing>: <glosses>" with an
# off-the-shelf MULTILINGUAL sentence model (default multilingual-e5-small, 384-dim)
# and writes the vectors into the server-only `word_embeddings` table. Nearest
# neighbours by cosine = semantically related words (see related_words()).
#
# We BORROW the embedding space (no training). The model is downloaded once by
# sentence-transformers (~470 MB for e5-small) and cached.
#
# USAGE (throwaway venv, like build-frequency.py):
#   python3 -m venv /tmp/embvenv
#   /tmp/embvenv/bin/pip install sentence-transformers psycopg2-binary 'numpy<2'
#     (numpy<2 is REQUIRED: torch 2.2 was built against numpy 1.x; numpy 2.0 breaks
#      its ABI → "RuntimeError: Numpy is not available" at encode time.)
#   /tmp/embvenv/bin/python scripts/build-embeddings.py                    # DEFAULT: common ∪ freq≥250 (~41k for JA)
#   /tmp/embvenv/bin/python scripts/build-embeddings.py --freq-floor 150   # deeper into the tail (~62k for JA)
#   /tmp/embvenv/bin/python scripts/build-embeddings.py --common-only      # editorial set only (~22.6k)
#   /tmp/embvenv/bin/python scripts/build-embeddings.py --limit 1000       # quick pipeline proof
#
# COVERAGE: the default applies the frequency-floor policy (EMBED_FREQ_FLOOR) —
# embed the "fat common" set, omit the rare tail — applied identically to every
# language so storage stays bounded. The dictionary itself stays FULL (only the
# word-map is trimmed; rare words still translate via the cache/MT fallback).
#
# DB: DATABASE_URL, else local Supabase (postgres@127.0.0.1:54322). Idempotent:
# ON CONFLICT re-embeds in place. e5 wants a "query: " prefix for symmetric
# similarity; embeddings are L2-normalized so the `<=>` cosine operator is exact.
# =========================================================
from __future__ import annotations  # PEP 604 "int | None" hints on Python 3.9

import argparse
import os
import sys

DEFAULT_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
# KNOWN limitation of the SMALL model (observed 2026-06-24): for katakana loanwords
# related_words returns a spelling-family, not a meaning-family — ストライカー(striker)
# → streaker/stripper/stalker/stripe/trigger, with the truly-related pitcher last.
# Small e5 anchors on subword/orthographic overlap for single tokens, and the
# "<writing>: <glosses>" text collides on BOTH the katakana surface AND the English
# gloss. Fix = a stronger model (multilingual-e5-large 1024-dim / LaBSE) — needs the
# word_embeddings.embedding column migrated off vector(384) + a full re-embed. See
# CLAUDE.md (#11/#12 thread). Native-kanji vocabulary clusters fine.
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
EXPECTED_DIM = 384  # must match word_embeddings.embedding vector(384)

# -------- FREQUENCY-FLOOR POLICY (storage discipline; apply to EVERY language) --------
# We embed the "fat common" set — every entry that is editorially common OR whose
# surface clears this frequency floor — and OMIT the extremely-rare long tail.
# Rationale: the tail is ~5x the data for <0.01% of lookups, is never wanted as a
# related-word suggestion, and still TRANSLATES fine (the dictionary stays full and
# the MT fallback covers gaps — only the word-map/embeddings are trimmed). Applied
# IDENTICALLY per language so per-language storage stays predictable and bounded
# (~45k entries ≈ ~165MB at 384-dim), letting many languages fit one Pro plan
# without the rare tail ever forcing a tier upgrade. See CLAUDE.md (#11/#12).
#
# Units: wordfreq Zipf score x100 (the same scale stored in jmdict_*.frequency;
# higher = more common). 250 = Zipf 2.5, "moderately common". Raise it for a leaner
# set, lower it to embed deeper into the tail. Reference entry counts (full JMdict):
#   common-flag only ~22.6k · ∪f300 ~32k · ∪f250 ~41k · ∪f200 ~51k · ∪f150 ~62k.
EMBED_FREQ_FLOOR = 250


# -------- PER-SOURCE FETCH SEAM (one dictionary source per language) --------
# Each language's vectors come from its OWN dictionary source (JMdict for JA;
# CC-CEDICT for ZH; a KR dict for KO; ...). A source fetcher returns a list of
# (dictionary_ref, embed_text) tuples — the SHARED driver (encode + upsert below)
# and the frequency-floor policy don't care which source produced them. Register a
# new language by adding its fetcher to SOURCE_FETCHERS; the table key
# (source_lang, dictionary_ref) and related_words projection are the only other
# per-source pieces. Mirrors the frontend senses/ + difficulty/ registry pattern.
def fetch_jmdict_entries(cur, common_only: bool, freq_floor: int, limit: int | None):
    """JA source. (dictionary_ref=jmdict entry_id, 'writing: glosses') per entry —
    mirrors related_words's projection.

    Coverage (see EMBED_FREQ_FLOOR): the default embeds editorially-common entries
    PLUS anything clearing `freq_floor`, skipping the rare tail. `--common-only`
    keeps ONLY the editorial set (ignores the floor); `freq_floor == 0` embeds every
    entry (the full, unbounded set — use only for experiments).
    """
    if common_only:
        # entries that have at least one common kanji OR kana surface
        where = """WHERE EXISTS (SELECT 1 FROM jmdict_kanji k WHERE k.entry_id = e.entry_id AND k.common)
                      OR EXISTS (SELECT 1 FROM jmdict_kana  n WHERE n.entry_id = e.entry_id AND n.common)"""
    elif freq_floor > 0:
        # the policy: common OR a surface at/above the floor (freq_floor is an int
        # from argparse, so direct interpolation is safe). NULL frequency fails the
        # comparison → such (rare) entries are kept only if editorially common.
        where = f"""WHERE EXISTS (SELECT 1 FROM jmdict_kanji k WHERE k.entry_id = e.entry_id AND (k.common OR k.frequency >= {freq_floor}))
                      OR EXISTS (SELECT 1 FROM jmdict_kana  n WHERE n.entry_id = e.entry_id AND (n.common OR n.frequency >= {freq_floor}))"""
    else:
        where = ""  # freq_floor == 0 and not --common-only → embed everything
    sql = f"""
        SELECT e.entry_id,
          COALESCE(
            (SELECT k.text FROM jmdict_kanji k WHERE k.entry_id = e.entry_id
               ORDER BY k.common DESC, k.frequency DESC NULLS LAST, k.id LIMIT 1),
            (SELECT n.text FROM jmdict_kana n WHERE n.entry_id = e.entry_id
               ORDER BY n.common DESC, n.frequency DESC NULLS LAST, n.id LIMIT 1)
          ) AS writing,
          (SELECT string_agg(g.text, '; ' ORDER BY g.position)
             FROM jmdict_senses s JOIN jmdict_glosses g ON g.sense_id = s.id
            WHERE s.entry_id = e.entry_id
              AND s.id = (SELECT MIN(s2.id) FROM jmdict_senses s2 WHERE s2.entry_id = e.entry_id)
          ) AS gloss
        FROM jmdict_entries e
        {where}
        ORDER BY e.entry_id
        {"LIMIT " + str(limit) if limit else ""}
    """
    cur.execute(sql)
    rows = []
    for entry_id, writing, gloss in cur.fetchall():
        if not writing:
            continue  # nothing to embed
        text = f"{writing}: {gloss}" if gloss else writing
        rows.append((entry_id, text))
    return rows


# language code -> source fetcher. Add an entry to support a new language.
SOURCE_FETCHERS = {
    "JA": fetch_jmdict_entries,
}


def fetch_entries(cur, source_lang: str, common_only: bool, freq_floor: int, limit: int | None):
    """Dispatch to the registered source fetcher for `source_lang`."""
    fetcher = SOURCE_FETCHERS.get(source_lang)
    if fetcher is None:
        sys.exit(
            f"no embedding source registered for language '{source_lang}' "
            f"(have: {', '.join(sorted(SOURCE_FETCHERS))}). Add one to SOURCE_FETCHERS."
        )
    return fetcher(cur, common_only, freq_floor, limit)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source-lang", default="JA",
                    help=f"language to embed; must have a registered source "
                         f"(have: {', '.join(sorted(SOURCE_FETCHERS))})")
    ap.add_argument("--common-only", action="store_true",
                    help="only entries with a common editorial surface (ignores --freq-floor; ~22.6k for JA)")
    ap.add_argument("--freq-floor", type=int, default=EMBED_FREQ_FLOOR,
                    help=f"embed entries that are common OR have a surface frequency >= this "
                         f"(wordfreq Zipf x100; default {EMBED_FREQ_FLOOR}); 0 = embed every entry (no trim)")
    ap.add_argument("--limit", type=int, default=None, help="cap entries (pipeline proof)")
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()

    import psycopg2
    from sentence_transformers import SentenceTransformer

    db = os.environ.get("DATABASE_URL", DEFAULT_DB)
    conn = psycopg2.connect(db)
    conn.autocommit = False
    cur = conn.cursor()

    print(f"[embeddings] loading {args.model} …", flush=True)
    model = SentenceTransformer(args.model)
    dim = model.get_sentence_embedding_dimension()
    if dim != EXPECTED_DIM:
        sys.exit(f"model dim {dim} != table vector({EXPECTED_DIM}); pick a {EXPECTED_DIM}-dim model or migrate the column")

    policy = ("--common-only (editorial set)" if args.common_only
              else "every entry (no trim)" if args.freq_floor <= 0
              else f"common ∪ frequency >= {args.freq_floor}")
    print(f"[embeddings] source={args.source_lang}  coverage policy: {policy}", flush=True)
    rows = fetch_entries(cur, args.source_lang, args.common_only, args.freq_floor, args.limit)
    print(f"[embeddings] {len(rows)} entries to embed", flush=True)

    done = 0
    for i in range(0, len(rows), args.batch):
        chunk = rows[i : i + args.batch]
        # e5: prefix with "query: " for symmetric similarity; normalize for cosine.
        vecs = model.encode(
            [f"query: {t}" for _, t in chunk],
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        args_list = [
            (args.source_lang, eid, "[" + ",".join(f"{x:.6f}" for x in vec) + "]", args.model)
            for (eid, _), vec in zip(chunk, vecs)
        ]
        cur.executemany(
            """INSERT INTO word_embeddings (source_lang, dictionary_ref, embedding, model)
               VALUES (%s, %s, %s::vector, %s)
               ON CONFLICT (source_lang, dictionary_ref)
               DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
                             embedded_at = now()""",
            args_list,
        )
        conn.commit()
        done += len(chunk)
        print(f"[embeddings] {done}/{len(rows)}", flush=True)

    cur.close()
    conn.close()
    print(f"[embeddings] done: {done} vectors with {args.model}", flush=True)


if __name__ == "__main__":
    main()
