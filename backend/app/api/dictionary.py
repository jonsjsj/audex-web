"""Dictionary — what a word the reader selected means.

The browser asks this server, not the dictionary sites, so the reader's IP never reaches them and answers are cached
for everyone. Two free sources, tried in order:

1. dictionaryapi.dev (Wiktionary-derived, tidy JSON: phonetics, audio, examples, synonyms). Knows base words and many
   inflections ("walked" -> "simple past of walk").
2. Wiktionary's own definition API, for what the first one lacks (rarer words, other languages). Its definitions are
   HTML, which is flattened to plain text here.

A word neither knows is a 404, not an error: the sheet then offers to search another word.
"""
import html
import re
from collections import OrderedDict
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_identity
from app.core.database import Identity

router = APIRouter(prefix="/api/dictionary", tags=["dictionary"])

DICTIONARYAPI = "https://api.dictionaryapi.dev/api/v2/entries/en/"
WIKTIONARY = "https://en.wiktionary.org/api/rest_v1/page/definition/"
USER_AGENT = "audex-web-dictionary/1.0 (self-hosted audiobook and ebook reader)"

MAX_WORD_CHARS = 60
MAX_MEANINGS = 6  # parts of speech shown
MAX_DEFINITIONS = 5  # per part of speech
MAX_SYNONYMS = 8
CACHE_SIZE = 3000

_WORD = re.compile(r"^[^\W\d_]+(?:[-' ][^\W\d_]+)*$", re.UNICODE)
_TAG = re.compile(r"<[^>]+>")
_SPACES = re.compile(r"\s+")

# word -> result (or None for "not found"); most recently used last.
_cache: "OrderedDict[str, dict | None]" = OrderedDict()


def clean_word(raw: str) -> str:
    """The word to look up, or '' when the text isn't a word (digits, a sentence, symbols)."""
    word = (raw or "").replace("’", "'").replace("‘", "'").strip().strip(".,;:!?\"()[]{}“”—–-").strip()
    word = _SPACES.sub(" ", word)
    if not word or len(word) > MAX_WORD_CHARS or not _WORD.match(word):
        return ""
    return word.lower()


def plain(text: str) -> str:
    """Wiktionary's HTML flattened to one line of text."""
    return _SPACES.sub(" ", html.unescape(_TAG.sub("", text or ""))).strip()


def from_dictionaryapi(data: object) -> dict | None:
    if not isinstance(data, list) or not data:
        return None
    phonetic = ""
    audio = ""
    merged: "OrderedDict[str, dict]" = OrderedDict()
    for entry in data:
        if not isinstance(entry, dict):
            continue
        phonetic = phonetic or entry.get("phonetic") or ""
        for p in entry.get("phonetics") or []:
            if isinstance(p, dict):
                phonetic = phonetic or p.get("text") or ""
                audio = audio or p.get("audio") or ""
        for m in entry.get("meanings") or []:
            if not isinstance(m, dict):
                continue
            pos = str(m.get("partOfSpeech") or "").strip()
            bucket = merged.setdefault(pos, {"partOfSpeech": pos, "definitions": [], "synonyms": []})
            for d in m.get("definitions") or []:
                if isinstance(d, dict) and d.get("definition"):
                    bucket["definitions"].append({"definition": str(d["definition"]).strip(), "example": str(d.get("example") or "").strip()})
            for s in list(m.get("synonyms") or []) + [x for d in m.get("definitions") or [] if isinstance(d, dict) for x in d.get("synonyms") or []]:
                if isinstance(s, str) and s not in bucket["synonyms"]:
                    bucket["synonyms"].append(s)
    meanings = []
    for m in list(merged.values())[:MAX_MEANINGS]:
        m["definitions"] = m["definitions"][:MAX_DEFINITIONS]
        m["synonyms"] = m["synonyms"][:MAX_SYNONYMS]
        if m["definitions"]:
            meanings.append(m)
    if not meanings:
        return None
    return {"phonetic": phonetic, "audio": audio, "meanings": meanings, "language": "English", "source": "dictionaryapi.dev"}


def from_wiktionary(data: object) -> dict | None:
    """Wiktionary groups entries by language code; English first, otherwise whichever language has the word."""
    if not isinstance(data, dict) or not data:
        return None
    code = "en" if data.get("en") else next(iter(data))
    entries = data.get(code)
    if not isinstance(entries, list):
        return None
    merged: "OrderedDict[str, dict]" = OrderedDict()
    language = "English"
    for e in entries:
        if not isinstance(e, dict):
            continue
        language = e.get("language") or language
        pos = str(e.get("partOfSpeech") or "").strip().lower()
        bucket = merged.setdefault(pos, {"partOfSpeech": pos, "definitions": [], "synonyms": []})
        for d in e.get("definitions") or []:
            if not isinstance(d, dict):
                continue
            text = plain(d.get("definition") or "")
            if text:
                examples = d.get("parsedExamples") or []
                ex = plain(examples[0].get("example") if examples and isinstance(examples[0], dict) else "")
                bucket["definitions"].append({"definition": text, "example": ex})
    meanings = []
    for m in list(merged.values())[:MAX_MEANINGS]:
        m["definitions"] = m["definitions"][:MAX_DEFINITIONS]
        if m["definitions"]:
            meanings.append(m)
    if not meanings:
        return None
    return {"phonetic": "", "audio": "", "meanings": meanings, "language": language, "source": "Wiktionary"}


async def _fetch(client: httpx.AsyncClient, url: str) -> object | None:
    """JSON from url, None when the site says it doesn't have it, httpx errors when it can't be reached."""
    r = await client.get(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    if r.status_code == 404:
        return None
    r.raise_for_status()
    return r.json()


async def look_up(word: str) -> dict | None:
    try:
        async with httpx.AsyncClient(timeout=8, follow_redirects=True) as client:
            found = from_dictionaryapi(await _fetch(client, DICTIONARYAPI + quote(word, safe="")))
            source_url = "https://en.wiktionary.org/wiki/" + quote(word, safe="")
            if found is None:
                found = from_wiktionary(await _fetch(client, WIKTIONARY + quote(word, safe="")))
    except (httpx.HTTPError, ValueError) as e:
        raise HTTPException(502, "The dictionary can't be reached right now.") from e
    if found is None:
        return None
    found["word"] = word
    found["sourceUrl"] = source_url
    return found


@router.get("")
async def define(word: str, _: Identity = Depends(get_current_identity)):
    clean = clean_word(word)
    if not clean:
        raise HTTPException(400, "That isn't a word.")
    if clean in _cache:
        _cache.move_to_end(clean)
        found = _cache[clean]
    else:
        found = await look_up(clean)
        _cache[clean] = found
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)
    if found is None:
        raise HTTPException(404, f"No definition found for “{clean}”.")
    return found
