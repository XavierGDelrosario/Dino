// =========================================================
// Publish authored lessons to the public `lessons` Storage bucket (migration 20260796).
//
//   npm run lessons:publish                    # local stack (http://127.0.0.1:54321)
//   npm run lessons:publish -- --dry-run       # validate + print the plan, upload nothing
//   npm run lessons:publish -- --lang JA       # one learning language only
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<secret> npm run lessons:publish
//
// SOURCE (authored, in git):
//   content/lessons/<LANG>/<id>.json        one lesson; <id> must equal the file stem
//   content/lessons/<LANG>/images/<name>    images it references as "images/<name>"
//   content/lessons/<LANG>/quizzes/<id>.json  one multiple-choice quiz (same images/)
//
// PUBLISHED (in the bucket):
//   <LANG>/images/<name>.<hash>.<ext>       content-addressed, cached for a year
//   <LANG>/<id>.<hash>.json                 content-addressed (image refs rewritten), a year
//   <LANG>/quizzes/<id>.<hash>.json         content-addressed quizzes, a year
//   <LANG>/index.json, <LANG>/quizzes/index.json
//                                           the manifests, 60 s cache — uploaded LAST, so
//                                           they never name a file that isn't there yet
//
// Every lesson is parsed in STRICT mode with the same parser the app uses, so a block
// the app would silently drop fails here instead. Re-publishing unchanged content
// re-uploads identical objects (same names) — idempotent. Old hashed files are left in
// place: a client holding the previous index can still open what it lists.
// =========================================================
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseLesson, parseQuiz, LESSON_ID, IMAGE_PATH } from "../src/services/lessons/parse";

const ROOT = join(import.meta.dirname, "..", "content", "lessons");
const BUCKET = "lessons";
const LOCAL_URL = "http://127.0.0.1:54321";
const IMMUTABLE = "31536000";
const INDEX_CACHE = "60";
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const langArg = args.includes("--lang") ? args[args.indexOf("--lang") + 1]?.toUpperCase() : undefined;

/** The LOCAL stack's service key, read from `supabase status` — never hard-coded. */
function localServiceKey(): string | undefined {
  try {
    const env = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = env.match(/^SERVICE_ROLE_KEY="?([^"\n]+)"?$/m);
    return m?.[1];
  } catch {
    return undefined;
  }
}

const hash = (buf: Buffer | string) => createHash("sha256").update(buf).digest("hex").slice(0, 10);

interface Upload {
  path: string;
  body: Buffer;
  contentType: string;
  cacheControl: string;
}

type Json = Record<string, unknown>;

/** Rewrite an authored image ref ("images/a.png" or {src}) to its published path. */
function rewriteImage(ref: unknown, map: Map<string, string>, where: string): unknown {
  if (ref === undefined) return ref;
  const src = typeof ref === "string" ? ref : (ref as Json).src;
  const published = typeof src === "string" ? map.get(src) : undefined;
  if (!published) throw new Error(`${where}: image ${JSON.stringify(src)} not found under images/`);
  return typeof ref === "string" ? published : { ...(ref as Json), src: published };
}

function buildLanguage(lang: string): { uploads: Upload[]; indexes: Upload[]; count: number; quizCount: number } {
  const dir = join(ROOT, lang);
  const uploads: Upload[] = [];

  // Images first: their published names feed the lesson rewrite.
  const imageMap = new Map<string, string>();
  const imgDir = join(dir, "images");
  if (existsSync(imgDir)) {
    for (const name of readdirSync(imgDir).sort()) {
      const ext = extname(name).toLowerCase();
      if (!MIME[ext]) {
        if (!name.startsWith(".")) console.warn(`  skip images/${name} (unsupported type)`);
        continue;
      }
      const body = readFileSync(join(imgDir, name));
      const published = `images/${basename(name, extname(name))}.${hash(body)}${ext}`;
      if (!IMAGE_PATH.test(published)) throw new Error(`images/${name}: name must be [A-Za-z0-9_.-]`);
      imageMap.set(`images/${name}`, published);
      uploads.push({ path: `${lang}/${published}`, body, contentType: MIME[ext], cacheControl: IMMUTABLE });
    }
  }

  const entries: Json[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const id = basename(name, ".json");
    const where = `${lang}/${name}`;
    if (!LESSON_ID.test(id)) throw new Error(`${where}: file name must be a lesson id (a-z, 0-9, -)`);
    const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Json;
    if (raw.id !== id) throw new Error(`${where}: "id" must be "${id}"`);
    if (String(raw.language ?? "").toUpperCase() !== lang) throw new Error(`${where}: "language" must be "${lang}"`);

    const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map((b: Json, i: number) => {
      if (b?.type === "image") return { ...b, image: rewriteImage(b.image, imageMap, `${where} block ${i}`) };
      if (b?.type === "cards" && Array.isArray(b.cards))
        return {
          ...b,
          cards: b.cards.map((c: Json, j: number) =>
            c?.image === undefined ? c : { ...c, image: rewriteImage(c.image, imageMap, `${where} block ${i} card ${j}`) },
          ),
        };
      return b;
    });
    const published = { ...raw, blocks };
    const lesson = parseLesson(published, { strict: true }); // throws on anything the app would drop
    const body = Buffer.from(JSON.stringify(published));
    const file = `${id}.${hash(body)}.json`;
    uploads.push({ path: `${lang}/${file}`, body, contentType: "application/json", cacheControl: IMMUTABLE });
    entries.push({
      id,
      file,
      schema: lesson.schema,
      level: lesson.level,
      order: typeof raw.order === "number" ? raw.order : 0,
      title: lesson.title,
      summary: raw.summary ?? {},
    });
    console.log(`  ${lang}/${file}  (${lesson.blocks.length} blocks)`);
  }

  const indexes: Upload[] = [
    {
      path: `${lang}/index.json`,
      body: Buffer.from(JSON.stringify({ schema: 1, language: lang, lessons: entries }, null, 2)),
      contentType: "application/json",
      cacheControl: INDEX_CACHE,
    },
  ];

  // Quizzes: same id/language rules, image refs rewritten per question, strict parse.
  const quizEntries: Json[] = [];
  const quizDir = join(dir, "quizzes");
  if (existsSync(quizDir)) {
    for (const name of readdirSync(quizDir).filter((f) => f.endsWith(".json")).sort()) {
      const id = basename(name, ".json");
      const where = `${lang}/quizzes/${name}`;
      if (!LESSON_ID.test(id)) throw new Error(`${where}: file name must be a quiz id (a-z, 0-9, -)`);
      const raw = JSON.parse(readFileSync(join(quizDir, name), "utf8")) as Json;
      if (raw.id !== id) throw new Error(`${where}: "id" must be "${id}"`);
      if (String(raw.language ?? "").toUpperCase() !== lang) throw new Error(`${where}: "language" must be "${lang}"`);
      const questions = (Array.isArray(raw.questions) ? raw.questions : []).map((q: Json, i: number) =>
        q?.image === undefined ? q : { ...q, image: rewriteImage(q.image, imageMap, `${where} question ${i}`) },
      );
      const published = { ...raw, questions };
      const quiz = parseQuiz(published, { strict: true });
      const body = Buffer.from(JSON.stringify(published));
      const file = `${id}.${hash(body)}.json`;
      uploads.push({ path: `${lang}/quizzes/${file}`, body, contentType: "application/json", cacheControl: IMMUTABLE });
      quizEntries.push({
        id,
        file,
        schema: quiz.schema,
        level: quiz.level,
        order: typeof raw.order === "number" ? raw.order : 0,
        title: quiz.title,
        summary: raw.summary ?? {},
      });
      console.log(`  ${lang}/quizzes/${file}  (${quiz.questions.length} questions)`);
    }
    indexes.push({
      path: `${lang}/quizzes/index.json`,
      body: Buffer.from(JSON.stringify({ schema: 1, language: lang, lessons: quizEntries }, null, 2)),
      contentType: "application/json",
      cacheControl: INDEX_CACHE,
    });
  }
  return { uploads, indexes, count: entries.length, quizCount: quizEntries.length };
}

async function main() {
  if (!existsSync(ROOT)) throw new Error(`no ${ROOT}`);
  const langs = readdirSync(ROOT)
    .filter((d) => statSync(join(ROOT, d)).isDirectory() && /^[A-Z]{2}(-[A-Za-z]+)?$/.test(d))
    .filter((d) => !langArg || d === langArg);
  if (langs.length === 0) throw new Error(langArg ? `no content/lessons/${langArg}` : "no language folders");

  const url = process.env.SUPABASE_URL ?? LOCAL_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? (url === LOCAL_URL && !dryRun ? localServiceKey() : undefined);
  if (!dryRun && !key)
    throw new Error(
      url === LOCAL_URL
        ? "Couldn't read the local service key — is `supabase start` running?"
        : "SUPABASE_SERVICE_ROLE_KEY is required for a non-local SUPABASE_URL",
    );
  const supabase = dryRun ? null : createClient(url, key!, { auth: { persistSession: false } });

  for (const lang of langs) {
    console.log(`${lang}:`);
    const { uploads, indexes, count, quizCount } = buildLanguage(lang);
    if (dryRun) {
      console.log(
        `  dry run — would upload ${uploads.length} files + ${indexes.length} index(es) (${count} lessons, ${quizCount} quizzes) to ${url}`,
      );
      continue;
    }
    for (const u of [...uploads, ...indexes]) {
      const { error } = await supabase!.storage
        .from(BUCKET)
        .upload(u.path, u.body, { contentType: u.contentType, cacheControl: u.cacheControl, upsert: true });
      if (error) throw new Error(`upload ${u.path}: ${error.message}`);
    }
    console.log(`  published ${count} lessons + ${quizCount} quizzes (${uploads.length} files + ${indexes.length} index(es)) to ${url}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
