-- =========================================================
-- Size and row ceilings on the client-writable user tables (pre-publish QA, 2026-10-05).
--
-- RLS lets any authenticated caller — and every visitor IS one: a guest is minted at
-- page load, with no captcha — write its own rows as fast and as large as it likes.
-- Nothing bounded a row or a user, so one scripted guest posting multi-hundred-KB
-- `custom_translation` values could fill the 500 MB free tier and put the whole
-- project read-only. media_favorites already had a per-user cap (20260749); this
-- gives user_words and lists the same, plus length limits.
--
-- LENGTHS are CHECK constraints added NOT VALID: enforced for every new or updated
-- row, without scanning (or failing on) what an environment already holds. Measured on
-- prod before choosing them: longest input 13, custom meaning 37, list name 7.
--
-- ROW CAPS are BEFORE INSERT triggers. Measured: the largest vocabulary is 3,538
-- words and 6 lists; the largest guest has 3 words. Guests get a lower ceiling —
-- they are the unauthenticated surface — and keep everything on upgrade (same uid).
-- A caller with no JWT (service role, migrations, the SQL editor) is not capped, and
-- claim_guest_merge MOVES rows by UPDATE, so a merge never trips the trigger.
-- =========================================================

ALTER TABLE user_words
  ADD CONSTRAINT user_words_input_len CHECK (char_length(input) <= 200) NOT VALID,
  ADD CONSTRAINT user_words_custom_translation_len
    CHECK (custom_translation IS NULL OR char_length(custom_translation) <= 2000) NOT VALID,
  ADD CONSTRAINT user_words_lang_len
    CHECK (char_length(source_lang) <= 16 AND char_length(target_lang) <= 16) NOT VALID;

ALTER TABLE lists
  ADD CONSTRAINT lists_list_name_len CHECK (char_length(list_name) <= 100) NOT VALID;

-- One function for both tables: TG_ARGV carries (account ceiling, guest ceiling).
CREATE OR REPLACE FUNCTION user_rows_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER              -- counts the user's rows regardless of the caller's RLS view
SET search_path = public, pg_temp
AS $$
DECLARE
  v_is_guest BOOLEAN := COALESCE((auth.jwt() ->> 'is_anonymous')::BOOLEAN, FALSE);
  v_max      INT := CASE WHEN v_is_guest THEN TG_ARGV[1]::INT ELSE TG_ARGV[0]::INT END;
  v_count    INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;               -- server-side writer: not the surface this guards
  END IF;
  EXECUTE format('SELECT count(*) FROM %I WHERE user_id = $1', TG_TABLE_NAME)
     INTO v_count USING NEW.user_id;
  IF v_count >= v_max THEN
    RAISE EXCEPTION '% limit reached (% rows)', TG_TABLE_NAME, v_max USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION user_rows_cap() FROM public, anon, authenticated;

DROP TRIGGER IF EXISTS trg_user_words_cap ON user_words;
CREATE TRIGGER trg_user_words_cap
BEFORE INSERT ON user_words
FOR EACH ROW EXECUTE FUNCTION user_rows_cap(20000, 5000);

DROP TRIGGER IF EXISTS trg_lists_cap ON lists;
CREATE TRIGGER trg_lists_cap
BEFORE INSERT ON lists
FOR EACH ROW EXECUTE FUNCTION user_rows_cap(500, 100);
