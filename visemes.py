"""Approximate Mandarin visemes from real EdgeTTS word timestamps.

WordBoundary is not a phoneme alignment. Mandarin initials/finals supply the
shape sequence; the client gates its amplitude with the actual audio envelope.
"""
from __future__ import annotations
import re
from pypinyin import Style, pinyin

SHAPES = ("aa", "ih", "ou", "ee", "oh")

def syllables(text: str) -> list[tuple[str, str, str]]:
    chars = [c for c in text if not re.match(r"[\s，。！？、；：,.!?;:]", c)]
    if not chars:
        return []
    # Process phrases together so polyphonic characters use phrase dictionaries.
    phrase = "".join(chars)
    finals = pinyin(phrase, style=Style.FINALS, strict=False, errors=lambda s: list(s))
    initials = pinyin(phrase, style=Style.INITIALS, strict=False, errors=lambda s: [""] * len(s))
    return [(c, ini[0], fin[0].replace("ü", "v")) for c, ini, fin in zip(chars, initials, finals)]

def final_shapes(final: str) -> list[tuple[str, float]]:
    # A diphthong moves through two mouth shapes instead of holding one.
    final = final.lower()
    if final in ("ai", "uai"):
        return [("aa", .62), ("ih", .38)]
    if final in ("ao", "iao"):
        return [("aa", .60), ("oh", .26), ("ou", .14)]
    if final in ("ei", "uei", "ui"):
        return [("ee", .60), ("ih", .40)]
    if final in ("ou", "iou", "iu"):
        return [("oh", .48), ("ou", .52)]
    if final in ("ie", "ve", "ue"):
        return [("ih", .30), ("ee", .70)]
    if final in ("ua", "uan", "uang"):
        return [("ou", .24), ("aa", .76)]
    if final in ("uo",):
        return [("ou", .24), ("oh", .76)]
    if final in ("ia", "ian", "iang"):
        return [("ih", .22), ("aa", .78)]
    if "a" in final:
        return [("aa", 1.)]
    if final in ("o", "ong", "iong"):
        return [("oh", 1.)]
    if final.startswith("u") or final.startswith("v"):
        return [("ou", 1.)]
    if final.startswith("i"):
        return [("ih", 1.)]
    if "e" in final:
        return [("ee", 1.)]
    # Latin letters are a rough visual fallback; Mandarin is the v0.1 target.
    return [(next((s for v, s in (("a", "aa"), ("e", "ee"), ("i", "ih"), ("o", "oh"), ("u", "ou")) if v in final), "aa"), 1.)]

def make_timeline(words: list[dict]) -> list[dict]:
    result = []
    for word in words:
        start = float(word["offset"]) / 10_000_000
        duration = max(0., float(word["duration"]) / 10_000_000)
        phones = syllables(word["text"])
        if not phones or not duration:
            continue
        part = duration / len(phones)
        for index, (char, initial, final) in enumerate(phones):
            cursor = start + index * part
            # Bilabial consonants begin with real closure; silence also stays closed.
            closure = .18 if initial in ("b", "p", "m") else .06
            result.append({"start": round(cursor, 5), "end": round(cursor + closure * part, 5), "shape": "closed", "text": char})
            cursor += closure * part
            vowel_duration = part * (1. - closure)
            for shape, fraction in final_shapes(final):
                end = cursor + vowel_duration * fraction
                result.append({"start": round(cursor, 5), "end": round(end, 5), "shape": shape, "text": char})
                cursor = end
    return result
