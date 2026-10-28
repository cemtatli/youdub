"""English -> Turkish translation for youdub, with OPUS-MT on CTranslate2 (int8, ~230 MB).

YouTube's own Turkish runs 25-60% longer than the English it replaces, so the voice had to
rush or the video had to slow down. This model stays close to the English length, and it
returns several candidate translations: we take the best one that fits the sentence's
time, as long as it is nearly as likely as the best.

Model: Helsinki-NLP/opus-mt-tc-big-en-tr (CC-BY-4.0), converted by install.sh into
models/opus-mt-en-tr. Without it, /translate is off and youdub uses YouTube's translation.
"""

import re
from pathlib import Path

MODEL = Path(__file__).parent / "models" / "opus-mt-en-tr"
CANDIDATES = 4
SCORE_MARGIN = 0.12  # a shorter candidate may score this much lower (log-prob per token)
MIN_SAVING = 0.92  # ...and must be at most this fraction of the best one's length

# Spoken English is full of words that carry no meaning in a dub. Turkish gets longer with
# every one of them ("So" -> "Bu yüzden"), so they go before translation.
# "So"/"and" open a sentence as filler before a comma or a subject ("So today I...", "And
# we..."), but carry meaning elsewhere ("So the problem becomes...").
LEADING = re.compile(
    r"^(?:(?:okay|ok|alright|all right|yeah|um+|uh+)\b[,.]?\s+"
    r"|(?:so|and|but|well|now),\s*|(?:so|and)\s+(?=(?:today|i|we|you|let's|here|this)\b))+",
    re.I,
)
FILLERS = re.compile(r",?\s*\b(?:um+|uh+|basically|literally)\b,?(?=\s|$)|,\s*you know\b,?(?=\s|$)", re.I)

translator = None
source_spm = None
target_spm = None


def available():
    return (MODEL / "model.bin").exists()


def load():
    global translator, source_spm, target_spm
    if translator is not None or not available():
        return
    import ctranslate2
    import sentencepiece

    translator = ctranslate2.Translator(str(MODEL), device="cpu", compute_type="int8", intra_threads=2)  # leave cores for the video
    source_spm = sentencepiece.SentencePieceProcessor(model_file=str(MODEL / "source.spm"))
    target_spm = sentencepiece.SentencePieceProcessor(model_file=str(MODEL / "target.spm"))


def trim(text):
    text = FILLERS.sub("", LEADING.sub("", text.strip()))
    text = re.sub(r"\s+", " ", text).strip(" ,")
    return text[:1].upper() + text[1:]


def translate(text, chars=None):
    """Turkish for `text`; with `chars`, prefer a translation at most that long."""
    text = trim(text)
    if not text:
        return ""
    # Marian models need the end-of-sentence token, or they repeat themselves.
    tokens = source_spm.encode(text, out_type=str) + ["</s>"]
    result = translator.translate_batch(
        [tokens], beam_size=CANDIDATES, num_hypotheses=CANDIDATES, return_scores=True, max_decoding_length=256
    )[0]
    options = [(target_spm.decode(h), s) for h, s in zip(result.hypotheses, result.scores)]
    best, best_score = options[0]
    if not chars or len(best) <= chars:
        return best
    # Candidates differ by a word or two, and one word can flip the meaning ("kullanmadan" ->
    # "kullanarak"), so a shorter one must buy real time to replace the best.
    close = [t for t, s in options if s >= best_score - SCORE_MARGIN and len(t) <= len(best) * MIN_SAVING]
    fitting = [t for t in close if len(t) <= chars]
    return fitting[0] if fitting else min(close, key=len, default=best)
