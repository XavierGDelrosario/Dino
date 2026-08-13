#!/usr/bin/env python3
# =========================================================
# Train the ENGLISH part-of-speech tagger → src/services/language/posEnModel.json
# (+ the golden fixture the TypeScript runtime is pinned against).
#
# WHY A TAGGER AT ALL. `analyze()` routes Japanese to kuromoji and everything else to
# `segmentOnly`, which has no POS beyond a hand-written closed-class list. So when
# ENGLISH is the language being learned, every capitalised name is offered as
# vocabulary: measured on en.wikinews, 23.5% of lookup keys miss the dictionary
# against 5.5% for ja.wikinews, and the misses are overwhelmingly proper nouns
# (UEFA, Abidal, Piraquara, WMAR). Each one is a paid MT call and a cache row.
#
# SOURCE: Universal Dependencies English-EWT (CC BY-SA 4.0) — the same licence family
# as the wordfreq data we already ship. We ship only the DERIVED weights, never the
# treebank. See ATTRIBUTION.md.
#
# TAGSET: UD UPOS, 17 tags. Chosen over Penn PTB deliberately — PTB's 36 tags triple
# the model's tag axis to draw distinctions (VBD vs VBN, NN vs NNS) that no consumer
# here reads, and UPOS maps 1:1 onto the PosCategory enum the UI already renders.
#
# MODEL: averaged perceptron (Collins 2002), the Honnibal feature set PLUS three
# orthographic features this codebase specifically needs — see FEATURES below.
#
# USAGE (stdlib only, no venv):
#   mkdir -p /tmp/ud && for f in train dev test; do curl -fsSL \
#     "https://raw.githubusercontent.com/UniversalDependencies/UD_English-EWT/master/en_ewt-ud-$f.conllu" \
#     -o /tmp/ud/$f.conllu; done
#   python3 scripts/build-pos-tagger.py /tmp/ud
# =========================================================
import json
import os
import random
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_OUT = os.path.join(ROOT, "src", "services", "language", "posEnModel.json")
GOLDEN_OUT = os.path.join(ROOT, "tests", "fixtures", "pos-en-golden.json")

ITERATIONS = 8
# Weights are stored as ints (weight * SCALE, rounded). A perceptron's decision is a
# comparison of sums, so uniform scaling cannot change the argmax; only the rounding
# can, and PRUNE drops the features too small to flip one.
SCALE = 10
PRUNE = 1  # after scaling: drop |w| < 1, i.e. a true weight under 0.1

START = ["-START-", "-START2-"]
END = ["-END-", "-END2-"]


# --- data ----------------------------------------------------------------

def read_conllu(path):
    """Yield [(form, upos), ...] per sentence. Skips multiword ranges (1-2) and
    empty nodes (1.1) — those carry no UPOS of their own."""
    sents, cur = [], []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line:
                if cur:
                    sents.append(cur)
                    cur = []
                continue
            if line.startswith("#"):
                continue
            cols = line.split("\t")
            if len(cols) < 4:
                continue
            if "-" in cols[0] or "." in cols[0]:
                continue
            cur.append((cols[1], cols[3]))
    if cur:
        sents.append(cur)
    return sents


# --- features ------------------------------------------------------------
# ‼️ MIRRORED IN src/services/language/posEn.ts. The two must produce byte-identical
# feature strings or the weights are meaningless. The golden fixture written at the
# bottom of this file is what proves they still agree — it is not decoration.

def normalize(word):
    """Collapse the classes that would otherwise blow up the feature space with
    hapaxes. Lowercasing loses capitalisation, which is why `shape` exists below."""
    if "-" in word and word[0] != "-":
        return "!HYPHEN"
    if word.isdigit():
        return "!YEAR" if len(word) == 4 else "!DIGITS"
    return word.lower()


def shape(word):
    """Orthographic class, kept SEPARATELY from the normalized form.

    This is the addition that earns its place here. The stock recipe lowercases
    everything, so a tagger trained on it has no direct evidence for PROPN — which is
    the single distinction this whole feature exists to make. `Xx` (Abidal) versus `xx`
    (forces) versus `XX` (UEFA) is most of that signal."""
    if not word:
        return ""
    if word.isdigit():
        return "d"
    if word.isupper():
        return "XX"
    if word[0].isupper():
        return "Xx"
    if word.islower():
        return "xx"
    return "mixed"


def features(i, word, context, prev, prev2):
    """context is the normalized sentence padded with START/END, so context[i+2] is
    the token at i. `i` is the index into the ORIGINAL sentence, used for the
    sentence-initial flag."""
    feats = defaultdict(int)

    def add(name, *args):
        feats[" ".join((name,) + tuple(args))] += 1

    add("bias")
    add("i suffix", word[-3:])
    add("i pref1", word[0] if word else "")
    add("i-1 tag", prev)
    add("i-2 tag", prev2)
    add("i tag+i-2 tag", prev, prev2)
    add("i word", context[i + 2])
    add("i-1 tag+i word", prev, context[i + 2])
    add("i-1 word", context[i + 1])
    add("i-1 suffix", context[i + 1][-3:])
    add("i-2 word", context[i])
    add("i+1 word", context[i + 3])
    add("i+1 suffix", context[i + 3][-3:])
    add("i+2 word", context[i + 4])
    # --- the three additions, all aimed at PROPN in context ---
    # A capitalised word is only weak evidence of a name; a capitalised word that is
    # NOT sentence-initial is strong evidence. Separating the two is what keeps
    # "Cats sleep" from demoting `Cats` while still demoting `Abidal`.
    add("i shape", shape(word))
    add("i first", "1" if i == 0 else "0")
    add("i shape+first", shape(word), "1" if i == 0 else "0")
    return feats


# --- averaged perceptron -------------------------------------------------

class Perceptron:
    def __init__(self):
        self.weights = {}          # feature -> {tag: weight}
        self.classes = set()
        self._totals = defaultdict(float)   # (feature, tag) -> accumulated weight
        self._tstamps = defaultdict(int)    # (feature, tag) -> last update instant
        self.i = 0

    def predict(self, feats):
        scores = defaultdict(float)
        for feat, count in feats.items():
            row = self.weights.get(feat)
            if not row:
                continue
            for tag, weight in row.items():
                scores[tag] += weight * count
        # Ties broken by tag name so training is deterministic given the seed.
        return max(self.classes, key=lambda t: (scores[t], t))

    def update(self, truth, guess, feats):
        self.i += 1
        if truth == guess:
            return
        for feat in feats:
            row = self.weights.setdefault(feat, {})
            for tag, delta in ((truth, 1.0), (guess, -1.0)):
                key = (feat, tag)
                cur = row.get(tag, 0.0)
                self._totals[key] += (self.i - self._tstamps[key]) * cur
                self._tstamps[key] = self.i
                row[tag] = cur + delta

    def average(self):
        """Collins averaging: every weight becomes its mean over the whole run, which
        is what stops the final pass's mistakes from dominating the model."""
        for feat, row in self.weights.items():
            for tag in list(row):
                key = (feat, tag)
                total = self._totals[key] + (self.i - self._tstamps[key]) * row[tag]
                row[tag] = total / self.i if self.i else 0.0


# --- tagger --------------------------------------------------------------

class Tagger:
    def __init__(self):
        self.model = Perceptron()
        self.tagdict = {}

    def _make_tagdict(self, sentences, freq_thresh=20, ambiguity_thresh=0.97):
        """Words that are overwhelmingly ONE tag are decided by lookup, never by the
        model. This is accuracy AND size: it removes the commonest words from the
        weight table entirely, and they are the ones with the most feature mass."""
        counts = defaultdict(lambda: defaultdict(int))
        for sent in sentences:
            for word, tag in sent:
                counts[word][tag] += 1
        for word, tag_counts in counts.items():
            tag, mode = max(tag_counts.items(), key=lambda kv: kv[1])
            total = sum(tag_counts.values())
            if total >= freq_thresh and (mode / total) >= ambiguity_thresh:
                self.tagdict[word] = tag

    def tag_sentence(self, words):
        prev, prev2 = START
        context = START + [normalize(w) for w in words] + END
        out = []
        for i, word in enumerate(words):
            tag = self.tagdict.get(word)
            if not tag:
                feats = features(i, word, context, prev, prev2)
                tag = self.model.predict(feats)
            out.append(tag)
            prev2, prev = prev, tag
        return out

    def train(self, sentences, iterations=ITERATIONS, seed=1):
        self._make_tagdict(sentences)
        for sent in sentences:
            for _, tag in sent:
                self.model.classes.add(tag)
        rng = random.Random(seed)
        data = list(sentences)
        for it in range(iterations):
            correct = total = 0
            for sent in data:
                words = [w for w, _ in sent]
                truths = [t for _, t in sent]
                prev, prev2 = START
                context = START + [normalize(w) for w in words] + END
                for i, word in enumerate(words):
                    guess = self.tagdict.get(word)
                    if not guess:
                        feats = features(i, word, context, prev, prev2)
                        guess = self.model.predict(feats)
                        self.model.update(truths[i], guess, feats)
                    correct += guess == truths[i]
                    total += 1
                    prev2, prev = prev, guess
            rng.shuffle(data)
            print("  iter %d: train acc %.4f" % (it + 1, correct / total), file=sys.stderr)
        self.model.average()

    def evaluate(self, sentences):
        correct = total = 0
        gold_n = defaultdict(int)   # tag -> gold count      (recall denominator)
        pred_n = defaultdict(int)   # tag -> predicted count (precision denominator)
        hit = defaultdict(int)      # tag -> correct count
        # The number this project actually cares about: a REAL content word (a noun,
        # verb, adjective or adverb the learner could study) that we call PROPN and
        # therefore silently remove from their vocabulary. The functionWords header
        # states the asymmetry — noise is cheap, an unaddable word is not — so this is
        # reported separately rather than buried in an accuracy average.
        content = {"NOUN", "VERB", "ADJ", "ADV"}
        demoted_content = 0
        content_total = 0
        for sent in sentences:
            words = [w for w, _ in sent]
            gold = [t for _, t in sent]
            got = self.tag_sentence(words)
            for g, t in zip(got, gold):
                gold_n[t] += 1
                pred_n[g] += 1
                if g == t:
                    correct += 1
                    hit[t] += 1
                if t in content:
                    content_total += 1
                    if g == "PROPN":
                        demoted_content += 1
                total += 1
        return {
            "acc": correct / total if total else 0.0,
            "gold": gold_n,
            "pred": pred_n,
            "hit": hit,
            "demoted_content": demoted_content,
            "content_total": content_total,
        }


# --- export --------------------------------------------------------------

def export(tagger, path):
    tags = sorted(tagger.model.classes)
    tag_index = {t: i for i, t in enumerate(tags)}

    weights = {}
    kept = dropped = 0
    for feat, row in tagger.model.weights.items():
        flat = []
        for tag, w in row.items():
            q = int(round(w * SCALE))
            if abs(q) < PRUNE:
                dropped += 1
                continue
            flat.append(tag_index[tag])
            flat.append(q)
            kept += 1
        if flat:
            weights[feat] = flat

    model = {
        "tags": tags,
        "scale": SCALE,
        # tagdict is by far the cheapest accuracy in the file: index-encoded, it is a
        # few tens of KB and decides the majority of tokens without touching `weights`.
        "tagdict": {w: tag_index[t] for w, t in sorted(tagger.tagdict.items())},
        "weights": weights,
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(model, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    print("  weights kept %d, pruned %d (%.1f%%)" % (kept, dropped, 100.0 * dropped / max(1, kept + dropped)),
          file=sys.stderr)
    return model


class QuantizedTagger(Tagger):
    """Runs off the EXPORTED model dict rather than the trainer's float weights.

    Everything reported to the user is measured through this, because quantization and
    pruning happen between training and shipping and it would be dishonest to quote an
    accuracy the artifact cannot reproduce. It also mirrors, statement for statement,
    what posEn.ts does at runtime — so a disagreement here is a bug in the same place
    the golden fixture guards."""

    def __init__(self, model):
        self.tagdict_raw = model["tagdict"]
        self.tags = model["tags"]
        self.scale = model["scale"]
        self.weights = model["weights"]
        self.tagdict = {w: self.tags[i] for w, i in self.tagdict_raw.items()}

    def tag_sentence(self, words):
        prev, prev2 = START
        context = START + [normalize(w) for w in words] + END
        out = []
        for i, word in enumerate(words):
            tag = self.tagdict.get(word)
            if not tag:
                feats = features(i, word, context, prev, prev2)
                scores = defaultdict(float)
                for feat, count in feats.items():
                    flat = self.weights.get(feat)
                    if not flat:
                        continue
                    for k in range(0, len(flat), 2):
                        scores[self.tags[flat[k]]] += flat[k + 1] * count
                # Same tie-break as the trainer: highest score, then tag name.
                tag = max(self.tags, key=lambda t: (scores[t], t))
            out.append(tag)
            prev2, prev = prev, tag
        return out


def write_golden(tagger, sentences, path, n=60):
    """The cross-runtime pin. The TypeScript tagger must reproduce these tags EXACTLY;
    if a feature string drifts in one runtime and not the other, this is what fails.
    Same role as tests/services/projection-version.test.ts.

    Sentences are taken from the TEST split, so they are also text the model was not
    trained on."""
    cases = []
    for sent in sentences[:n]:
        words = [w for w, _ in sent]
        if not (2 <= len(words) <= 25):
            continue
        cases.append({"words": words, "tags": tagger.tag_sentence(words)})
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cases, fh, ensure_ascii=False, indent=1, sort_keys=True)
    return cases


def main():
    if len(sys.argv) < 2:
        print(__doc__ or "usage: build-pos-tagger.py <ud-dir>", file=sys.stderr)
        sys.exit(2)
    ud = sys.argv[1]
    train = read_conllu(os.path.join(ud, "train.conllu"))
    dev = read_conllu(os.path.join(ud, "dev.conllu"))
    test = read_conllu(os.path.join(ud, "test.conllu"))
    print("sentences: train %d, dev %d, test %d" % (len(train), len(dev), len(test)), file=sys.stderr)

    tagger = Tagger()
    print("training...", file=sys.stderr)
    tagger.train(train)

    model = export(tagger, MODEL_OUT)

    # Everything below measures the SHIPPED artifact, not the trainer.
    shipped = QuantizedTagger(model)
    for name, split in (("dev", dev), ("test", test)):
        r = shipped.evaluate(split)
        print("%s accuracy: %.4f" % (name, r["acc"]), file=sys.stderr)
        if name != "test":
            continue
        print("    %-6s %9s %9s" % ("tag", "prec", "recall"), file=sys.stderr)
        for tag in ("PROPN", "NOUN", "VERB", "ADJ", "ADV", "AUX"):
            g, p, h = r["gold"][tag], r["pred"][tag], r["hit"][tag]
            if not g:
                continue
            print("    %-6s %9s %9s  (gold %d)"
                  % (tag,
                     "%.4f" % (h / p) if p else "-",
                     "%.4f" % (h / g),
                     g), file=sys.stderr)
        print("    content words wrongly tagged PROPN: %d / %d (%.2f%%)"
              % (r["demoted_content"], r["content_total"],
                 100.0 * r["demoted_content"] / max(1, r["content_total"])), file=sys.stderr)

    cases = write_golden(shipped, test, GOLDEN_OUT)
    size = os.path.getsize(MODEL_OUT)
    print("wrote %s (%.2f MB), %d golden cases -> %s"
          % (os.path.relpath(MODEL_OUT, ROOT), size / 1e6, len(cases),
             os.path.relpath(GOLDEN_OUT, ROOT)), file=sys.stderr)


if __name__ == "__main__":
    main()
