"""Sentences for English auto captions, which come without punctuation or capitals.

Without sentence ends, the translator gets halves of sentences or two at once and the
Turkish comes out inverted ("devrik"). This model (1-800-BAD-CODE/punct_cap_seg_en,
Apache-2.0, int8 ONNX ~53 MB in models/punct-en, built by install.sh) adds punctuation and
capitals and splits the text into sentences: a whole video in about a second.

It is needed once per video and runs in worker.py's child process, which goes away when
idle, so its ~140 MB are not held while the video plays.
"""

from pathlib import Path

MODEL = Path(__file__).parent / "models" / "punct-en"
FILES = {"spe_filename": "spe_32k_lc_en.model", "model_filename": "punct_cap_seg_en.onnx", "config_filename": "config.yaml"}


def available():
    return (MODEL / FILES["model_filename"]).exists()


def sentences(text):
    from punctuators.models.punc_cap_seg_model import PunctCapSegConfigONNX, PunctCapSegModelONNX

    model = PunctCapSegModelONNX(PunctCapSegConfigONNX(directory=str(MODEL), **FILES))
    return [s.replace("<Unk>", "-") for s in model.infer([text], apply_sbd=True)[0]]
