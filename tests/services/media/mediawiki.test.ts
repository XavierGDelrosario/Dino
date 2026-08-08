import { describe, it, expect } from "vitest";
import {
  parseHeadlines,
  parsePage,
  stripHtml,
  capToSentence,
  articleUrl,
  stripArticleApparatus,
} from "@/services/media/mediawiki";

describe("stripHtml", () => {
  it("removes markup + entities and collapses whitespace", () => {
    expect(stripHtml('a <span class="x">b</span>\n&amp;c&quot;')).toBe('a b &c"');
  });
});

describe("parseHeadlines", () => {
  const JSON_OK = {
    query: {
      pages: {
        "12": { title: "訃報 稲葉興作氏", extract: "【2006年11月29日】 元社長の稲葉氏が…" },
        "34": { title: "", extract: "no title dropped" },
      },
    },
  };

  it("maps random pages to title + plain summary + wikinews url, dropping title-less rows", () => {
    const out = parseHeadlines(JSON_OK, "wikinews", "JA");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ title: "訃報 稲葉興作氏", summary: expect.stringContaining("稲葉") });
    expect(out[0].url).toContain("ja.wikinews.org/wiki/");
  });

  it("returns [] when the shape is missing", () => {
    expect(parseHeadlines({})).toEqual([]);
    expect(parseHeadlines(null)).toEqual([]);
  });
});

describe("parsePage", () => {
  it("pulls the first page's resolved title + extract", () => {
    const json = { query: { pages: { "12": { title: "本文", extract: "本文である。" } } } };
    expect(parsePage(json)).toEqual({ title: "本文", extract: "本文である。" });
  });

  it("returns empties when absent", () => {
    expect(parsePage({ query: { pages: {} } })).toEqual({ title: "", extract: "" });
    expect(parsePage(null)).toEqual({ title: "", extract: "" });
  });
});

describe("capToSentence", () => {
  it("leaves short text untouched", () => {
    expect(capToSentence("短い。", 100)).toBe("短い。");
  });

  it("truncates to the last Japanese sentence boundary under the cap", () => {
    expect(capToSentence("一文目。二文目はここで切れる。三文目。", 8)).toBe("一文目。");
  });
});

describe("articleUrl", () => {
  it("defaults to Japanese Wikinews, underscoring spaces", () => {
    expect(articleUrl("訃報 稲葉興作氏")).toContain("https://ja.wikinews.org/wiki/");
    expect(articleUrl("東京 タワー")).toBe(
      "https://ja.wikinews.org/wiki/%E6%9D%B1%E4%BA%AC_%E3%82%BF%E3%83%AF%E3%83%BC",
    );
  });

  it("maps the site + language", () => {
    expect(articleUrl("Volleyball", "wikipedia", "EN")).toBe(
      "https://en.wikipedia.org/wiki/Volleyball",
    );
  });
});

// The fixture is the SHAPE of a real ja.wikinews `explaintext` extract (sampled
// 2026-07-28): a 【date】 dateline, body prose, then the apparatus sections the
// reader shouldn't have to wade through — citation lists naming newspapers and
// dates, plus related-article links.
const REAL_SHAPE = [
  "【2016年5月9日】",
  "",
  "2016年4月24日(日)に「砂浜の草競馬」が2か所で行われた。",
  "1か所目は、照島海岸で行われた「串木野浜競馬大会」である。",
  "",
  "",
  "== 情報源 ==",
  " 『春の海岸52頭疾走　串木野浜競馬』 — 南日本新聞, 2016年4月24日",
  " 『砂浜を力強く疾走 さがら草競馬大会 牧之原』 — 静岡新聞, 2016年4月25日",
  "",
  "",
  "== ウィキニュース関連記事 ==",
  "鹿児島県で「第57回串木野浜競馬大会」が行われる 【2014年4月14日】",
].join("\n");

describe("stripArticleApparatus", () => {
  it("drops citation + related-article sections, keeps the dateline and prose", () => {
    const body = stripArticleApparatus(REAL_SHAPE);
    expect(body).toBe(
      [
        "【2016年5月9日】",
        "",
        "2016年4月24日(日)に「砂浜の草競馬」が2か所で行われた。",
        "1か所目は、照島海岸で行われた「串木野浜競馬大会」である。",
      ].join("\n"),
    );
    expect(body).not.toContain("南日本新聞");
    expect(body).not.toContain("第57回串木野浜競馬大会");
  });

  // The reason headings are matched individually instead of dropping every
  // section: a sampled article's 日本選手の成績など section is real news.
  it("KEEPS a content section, and keeps its heading text without the == markers", () => {
    const text = [
      "トリノ大会は閉会式が行われ幕を閉じた。",
      "",
      "== 日本選手の成績など ==",
      "荒川静香選手が金メダルを獲得した。",
      "",
      "== 出典 ==",
      "共同通信 『トリノ冬季五輪が閉幕』 — 日本経済新聞, 2006年2月27日",
    ].join("\n");
    const body = stripArticleApparatus(text);
    expect(body).toContain("日本選手の成績など");
    expect(body).not.toContain("== 日本選手の成績など ==");
    expect(body).toContain("荒川静香選手が金メダルを獲得した。");
    expect(body).not.toContain("日本経済新聞");
  });

  it("takes SUBSECTIONS of a dropped section with it", () => {
    const text = [
      "本文。",
      "== 出典 ==",
      "新聞A",
      "=== 一次資料 ===",
      "新聞B",
      "== 続報 ==",
      "続きの本文。",
    ].join("\n");
    const body = stripArticleApparatus(text);
    expect(body).not.toContain("新聞A");
    expect(body).not.toContain("一次資料");
    expect(body).not.toContain("新聞B");
    // …and resumes at the next non-apparatus heading of the same level.
    expect(body).toContain("続報");
    expect(body).toContain("続きの本文。");
  });

  it.each([
    "出典",
    "情報源",
    "脚注",
    "参考文献",
    "関連記事",
    "関連する記事",
    "関連項目",
    "ウィキニュース関連記事",
    "外部リンク",
    "Sources",
    "References",
    "External links",
    "Related news",
    "See also",
  ])("treats %s as apparatus", (heading) => {
    const body = stripArticleApparatus(`本文。\n== ${heading} ==\nDROPPED`);
    expect(body).toBe("本文。");
  });

  it("does not mistake ordinary prose containing 関連 for a link list", () => {
    const text = "本文。\n== 事故に関連した背景 ==\n背景の説明。";
    expect(stripArticleApparatus(text)).toContain("背景の説明。");
  });

  it("collapses the blank-line gaps a removal leaves behind", () => {
    expect(stripArticleApparatus("A。\n\n\n== 出典 ==\nx\n\n\n== 関連項目 ==\ny")).toBe("A。");
    expect(stripArticleApparatus("A。\n\n\n\nB。")).toBe("A。\n\nB。");
  });

  it("passes through an article with no sections at all, and handles empty input", () => {
    expect(stripArticleApparatus("ただの本文です。")).toBe("ただの本文です。");
    expect(stripArticleApparatus("")).toBe("");
  });
});
