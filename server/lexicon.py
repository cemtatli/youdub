"""English words inside Turkish captions, respelled the way they are said in Turkish.

The voice reads every word by Turkish spelling rules, so "feedback" comes out
"fe-ed-back". This builds a table from the CMU Pronouncing Dictionary (how English words
sound) and turns each pronunciation into Turkish letters: F IY D B AE K -> "fidbek".

Turkish words must stay as they are, and many are also in the CMU list ("bile", "son",
"ben"). Word frequencies from Turkish and English subtitles decide: the 5000 most common
Turkish words are kept ("can", "on"), and any other word is English when English uses it
more ("podcast", "email"). A spelling Turkish never has (w, th, oo, ...) is always English.

  python lexicon.py CMUDICT TR_FREQ EN_FREQ   # build data/en_tr.tsv (install.sh downloads them)
"""

import re
import sys
from pathlib import Path

DATA = Path(__file__).parent / "data"
TABLE = DATA / "en_tr.tsv"
TURKISH_CORE = 5000  # the most common Turkish words are never respelled

NOT_TURKISH = re.compile(r"[wxq]|th|sh|ch|ph|gh|ck|oo|ee|ea|ou|oa|[^aeiou]y$")
KEEP = {"ee", "premium"}  # Turkish as written: an interjection, a loanword

# Acronyms and brands the CMU list lacks or reads as a word ("AI" is the sloth "ay").
# Acronyms match only in capitals: Turkish ones (ABD, THY) keep their Turkish letter names.
EXACT = {
    "AI": "ey ay", "UI": "yu ay", "UX": "yu eks", "iOS": "ay o es", "CEO": "si i o",
    "CTO": "si ti o", "SaaS": "sas", "MVP": "em vi pi", "ROI": "ar o ay", "KPI": "key pi ay",
    "SEO": "es i o", "B2B": "bi tu bi", "B2C": "bi tu si", "GPT": "ci pi ti", "LLM": "el el em",
    "API": "ey pi ay", "PDF": "pi di ef", "URL": "yu ar el", "USB": "yu es bi",
    "iPhone": "ayfon", "iPad": "aypad", "MacBook": "mekbuk", "TikTok": "tik tok",
    "ChatGPT": "çet ci pi ti", "OpenAI": "opın ey ay", "GitHub": "githab", "YouTube": "yutub",
    "WhatsApp": "vatsap", "LinkedIn": "linkdin", "Xcode": "eks kod",
}
EXTRA_WORDS = {  # common in the videos, missing from the CMU list
    "paywall": "peyvol", "onboarding": "onbording", "freemium": "frimiyum", "app": "ep",
    "apps": "eps", "claude": "klod", "anthropic": "entropik", "notion": "noşın",
    "shopify": "şopifay", "nvidia": "envidya", "figma": "figma", "vercel": "vörsel",
}

CONSONANTS = {
    "B": "b", "CH": "ç", "D": "d", "DH": "d", "F": "f", "G": "g", "HH": "h", "JH": "c",
    "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ng", "P": "p", "R": "r", "S": "s",
    "SH": "ş", "T": "t", "TH": "t", "V": "v", "W": "v", "Y": "y", "Z": "z", "ZH": "j",
}
VOWELS = {
    "AA": "a", "AE": "e", "AO": "o", "AW": "au", "AY": "ay", "EH": "e", "EY": "ey",
    "IH": "i", "IY": "i", "OW": "o", "OY": "oy", "UH": "u", "UW": "u",
}


def to_turkish(word, phones):
    """ARPAbet -> Turkish letters. American "a" in "pod"/"Amazon" is written "o", so where
    the spelling has an "o" for that vowel we keep it."""
    spelled = re.findall(r"[aeiou]+", word)
    vowels = [p for p in phones if p[-1].isdigit()]
    aligned = len(spelled) == len(vowels)
    out, v = [], 0
    for p in phones:
        base, stress = p.rstrip("012"), p[-1]
        if base in CONSONANTS:
            out.append(CONSONANTS[base])
            continue
        letters = spelled[v] if aligned else ""
        v += 1
        if base == "AH":
            out.append("ı" if stress == "0" and out else "a")  # update -> "apdeyt"
        elif base == "ER":
            out.append("ır" if stress == "0" else "ör")
        elif base == "AA" and letters.startswith("o"):
            out.append("o")
        else:
            out.append(VOWELS.get(base, ""))
    return "".join(out)


def frequencies(path):
    """Word -> (rank, uses per million) from a FrequencyWords list ("word count" lines)."""
    counts = {}
    with open(path, encoding="utf-8") as lines:
        for line in lines:
            word, _, count = line.partition(" ")
            if count.strip().isdigit():
                counts.setdefault(word, int(count))
    total = sum(counts.values())
    return {w: (rank, c / total * 1e6) for rank, (w, c) in enumerate(counts.items())}


def build(cmudict_path, turkish_path, english_path):
    DATA.mkdir(exist_ok=True)
    turkish, english = frequencies(turkish_path), frequencies(english_path)

    def is_turkish(word):
        if word in KEEP:
            return True
        if NOT_TURKISH.search(word) or word not in turkish:
            return False
        rank, per_million = turkish[word]
        return rank < TURKISH_CORE or per_million >= english.get(word, (0, 0))[1]

    table = dict(EXTRA_WORDS)
    with open(cmudict_path, encoding="utf-8") as lines:
        for line in lines:
            parts = line.split("#")[0].split()
            if len(parts) < 2 or not re.fullmatch(r"[a-z]{2,}", parts[0]):
                continue  # alternates like "read(2)", abbreviations, one letter
            word = parts[0]
            if word in table or is_turkish(word):
                continue
            said = to_turkish(word, parts[1:])
            if said and said != word:
                table[word] = said
    TABLE.write_text("".join(f"{w}\t{s}\n" for w, s in sorted(table.items())), encoding="utf-8")
    print(f"{len(table)} words -> {TABLE}")


def load():
    if not TABLE.exists():
        return {}
    return dict(line.split("\t", 1) for line in TABLE.read_text(encoding="utf-8").splitlines())


# Whole words of ASCII letters only: "kullan" inside "kullanıcı" must not match.
WORD = re.compile(r"(?<!\w)[A-Za-z][A-Za-z0-9]*(?!\w)")


def respell(text, table):
    """Respell English words; Turkish suffixes after an apostrophe stay (YouTube'da)."""

    def one(match):
        word = match.group()
        if word in EXACT:
            return EXACT[word]
        if word.isupper() and len(word) > 1:
            return word  # unknown acronym: Turkish letter names, as the voice already does
        return table.get(word.lower(), word)

    return WORD.sub(one, text)


if __name__ == "__main__":
    build(*sys.argv[1:4])
