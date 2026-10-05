-- =========================================================
-- curated_names — hand-kept names the tokenizer reads or splits wrong.
--
-- The reader shows a person's or company's name with its reading romanized, and the
-- reading is the tokenizer's guess (services/lookup.ts, step 5). For most names that is
-- fine. For a famous one it is conspicuously wrong: 大谷翔平 comes out of kuromoji as
-- 大谷 (read オオヤ) + 翔 + 平, so the reader offered "Oya", a stray 翔, and 平 as the
-- ordinary word "flat".
--
-- A row here is the correction: the whole SURFACE as written, how it is read, and what
-- to show for it. The client loads the table once per session and, before any lookup,
-- folds a run of tokens whose surfaces join to a listed name into ONE name token.
--
-- Hand-kept on purpose — a few dozen rows of people a learner will actually meet in the
-- news, added with a plain INSERT, no deploy. It is not a names dictionary, and nothing
-- writes to it automatically.
--
-- Public, read-only reference data: every client may read it, none may write.
-- =========================================================

CREATE TABLE curated_names (
  surface     TEXT NOT NULL CHECK (btrim(surface) <> ''),
  source_lang TEXT NOT NULL DEFAULT 'JA',
  target_lang TEXT NOT NULL DEFAULT 'EN',
  reading     TEXT,                                      -- kana, shown beside the name
  meaning     TEXT NOT NULL CHECK (btrim(meaning) <> ''),-- what the card shows / saves
  kind        TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'organization')),
  PRIMARY KEY (surface, source_lang, target_lang)
);

ALTER TABLE curated_names ENABLE ROW LEVEL SECURITY;
CREATE POLICY curated_names_read ON curated_names FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON curated_names FROM anon, authenticated;
GRANT SELECT ON curated_names TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON curated_names TO service_role;

INSERT INTO curated_names (surface, reading, meaning) VALUES
  ('大谷翔平', 'おおたにしょうへい', 'Shohei Ohtani'),
  -- The surname alone, as a headline writes it. 大谷 is other people's surname too
  -- (usually romanized Otani); this spelling is his, and he is who the news means.
  ('大谷',     'おおたに',           'Ohtani');
