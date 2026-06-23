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
#   /tmp/embvenv/bin/python scripts/build-embeddings.py --common-only      # ~22.6k entries
#   /tmp/embvenv/bin/python scripts/build-embeddings.py --limit 1000       # quick pipeline proof
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
DEFAULT_MODEL = "intfloat/multilingual-e5-small"
EXPECTED_DIM = 384  # must match word_embeddings.embedding vector(384)


def fetch_entries(cur, common_only: bool, limit: int | None):
    """entry_id + 'writing: glosses' text per entry (mirrors related_words's projection)."""
    where = ""
    if common_only:
        # entries that have at least one common kanji OR kana surface
        where = """WHERE EXISTS (SELECT 1 FROM jmdict_kanji k WHERE k.entry_id = e.entry_id AND k.common)
                      OR EXISTS (SELECT 1 FROM jmdict_kana  n WHERE n.entry_id = e.entry_id AND n.common)"""
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--common-only", action="store_true", help="only entries with a common surface")
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

    rows = fetch_entries(cur, args.common_only, args.limit)
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
            (eid, "JA", "[" + ",".join(f"{x:.6f}" for x in vec) + "]", args.model)
            for (eid, _), vec in zip(chunk, vecs)
        ]
        cur.executemany(
            """INSERT INTO word_embeddings (jmdict_entry_id, source_lang, embedding, model)
               VALUES (%s, %s, %s::vector, %s)
               ON CONFLICT (jmdict_entry_id)
               DO UPDATE SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
                             source_lang = EXCLUDED.source_lang, embedded_at = now()""",
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
