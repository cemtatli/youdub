"""Sentences for English auto captions, which come without punctuation or capitals.

Without sentence ends, the translator gets halves of sentences or two at once and the
Turkish comes out inverted ("devrik"). This model (1-800-BAD-CODE/punct_cap_seg_en,
Apache-2.0, int8 ONNX ~53 MB in models/punct-en, built by install.sh) adds punctuation and
capitals and splits the text into sentences: a whole video in about a second.

It is needed once per video and runs in worker.py's child process, which goes away when
idle, so its ~140 MB are not held while the video plays.
"""

import re
import unicodedata
from pathlib import Path

MODEL = Path(__file__).parent / "models" / "punct-en"
FILES = {"spe_filename": "spe_32k_lc_en.model", "model_filename": "punct_cap_seg_en.onnx", "config_filename": "config.yaml"}


def available():
    return (MODEL / FILES["model_filename"]).exists()


def sentences(text):
    from punctuators.models.punc_cap_seg_model import PunctCapSegConfigONNX, PunctCapSegModelONNX

    model = PunctCapSegModelONNX(PunctCapSegConfigONNX(directory=str(MODEL), **FILES))
    sentences = model.infer([prepare(text)], apply_sbd=True)[0]
    # Characters outside the model's vocabulary come back as "<unk>" (any case); the voice
    # would say "unk". prepare() removes most of them, this catches the rest.
    sentences = [re.sub(r"\s+", " ", UNK.sub(" ", s)).strip() for s in sentences]
    return [s for s in sentences if re.search(r"\w", s)]


UNK = re.compile(r"\s*<unk>\s*", re.I)
# Auto captions mark sounds as [Music], [Applause], (laughs) and speaker changes as ">>".
# They are not speech, and the brackets are outside the model's vocabulary ("<unk>usic<unk>").
NOT_SPEECH = re.compile(r"\[[^\]]*\]|\([^)]*\)|>>|♪+")


def prepare(text):
    from translate import SYMBOLS  # plain regexes, no model load

    text = NOT_SPEECH.sub(" ", text)
    for pattern, repl in SYMBOLS:
        text = pattern.sub(repl, text)
    # The model adds punctuation to bare text; punctuation already there gets doubled
    # (",, OK,?."). Numbers keep theirs (2.5, 1,200).
    text = re.sub(r"(?<!\d)[.,!?;:]+|[.,!?;:]+(?!\d)", " ", text)
    # café -> cafe, Zoë -> Zoe: accented letters are also outside the vocabulary.
    text = "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))
    # The model's vocabulary is lowercase only (spe_32k_lc_en): any capital letter is "<unk>"
    # ("Celsius" -> "<unk>elsius"). It puts the capitals back itself.
    return re.sub(r"\s+", " ", text).strip().lower()
