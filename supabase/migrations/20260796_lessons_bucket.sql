-- =========================================================
-- Lessons — authored lessons served as FILES from a public Storage bucket.
--
-- Lessons live outside the app bundle so a new or corrected lesson reaches every
-- client (web AND the installed iOS app) without a release: the client fetches
-- `lessons/<LEARNING_LANG>/index.json`, then the lesson files and images it names.
-- Layout and schema: src/services/lessons/types.ts. Published from content/lessons/
-- by `npm run lessons:publish`.
--
-- PUBLIC READ, NO CLIENT WRITE. A public bucket serves objects at
-- /storage/v1/object/public/lessons/… without a policy (lessons are not user data,
-- so there is nothing to scope by auth.uid()). No storage.objects policies are added
-- for it, so anon/authenticated clients cannot upload, overwrite or delete — only the
-- service role (the publish script) can.
--
-- BOUNDED: lesson JSON + raster images only, 1 MB per object. No SVG — an SVG opened
-- by its public URL can run script, and nothing a lesson needs requires vector art.
-- =========================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'lessons', 'lessons', true, 1048576,
  ARRAY['application/json', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
