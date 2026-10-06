"""Язык ответов сервера: русский (как написан код) или английский.

Тексты, которые сайт показывает на странице, переводит сам браузер (public/js/i18n.js).
Но часть текста попадает НЕ на страницу, а внутрь готового блюпринта — название и
описание чертежа, которые потом видит игрок в игре. Их переводит сервер: страница
шлёт заголовок `X-Lang: en`, мидлвар кладёт язык в контекст запроса, а `encode_json`
(app/blueprint.py) переводит `label` и `description` перед упаковкой.

Словарь общий с браузером: `public/js/i18n-en.js` (русский фрагмент -> английский).
"""
from __future__ import annotations

import json
import re
from contextvars import ContextVar, Token
from pathlib import Path

_DICT_FILE = Path(__file__).resolve().parent.parent / "public" / "js" / "i18n-en.js"
_CYR = re.compile(r"[А-Яа-яЁё]")
_LETTER = "А-Яа-яЁё"

_lang: ContextVar[str] = ContextVar("chain_calc_lang", default="ru")
_phrases: dict[str, str] | None = None
_trie: dict | None = None
_HEAD = re.compile(rf"[{_LETTER}0-9]")
_LETTER_RE = re.compile(rf"[{_LETTER}]")


def set_lang(value: str | None) -> Token:
    """Язык по заголовку X-Lang: всё, что не «en», считаем русским."""
    return _lang.set("en" if (value or "").strip().lower().startswith("en") else "ru")


def reset_lang(token: Token) -> None:
    _lang.reset(token)


def is_en() -> bool:
    return _lang.get() == "en"


def _load() -> None:
    global _phrases, _trie
    if _phrases is not None:
        return
    _phrases = {}
    try:
        text = _DICT_FILE.read_text(encoding="utf-8")
        start = text.index("{", text.index("window.__I18N_EN"))
        end = text.rindex("}")
        _phrases = json.loads(text[start:end + 1])
    except (OSError, ValueError):
        _phrases = {}
    # интерфейс местами пишет названия с маленькой буквы («качество»): у каждой фразы,
    # начинающейся с заглавной, есть двойник со строчной
    for key in list(_phrases):
        first = key[0]
        if first != first.lower() and re.match(r"[А-ЯЁ]", first):
            twin = first.lower() + key[1:]
            _phrases.setdefault(twin, _phrases[key][:1].lower() + _phrases[key][1:])
    _trie = {}
    for key in _phrases:
        node = _trie
        for ch in key:
            node = node.setdefault(ch, {})
        node["$"] = key


def tr(text: str) -> str:
    """Перевод строки на английский (если сервер сейчас отвечает по-английски).

    Так же, как в браузере (public/js/i18n.js): находим все фразы словаря в любом месте текста,
    а при пересечении побеждает самая длинная. Пробелы и переводы строк в ключах равноценны.
    """
    if not text or not is_en() or not _CYR.search(text):
        return text
    _load()
    # normalised copy (whitespace runs -> one space) + where each of its chars sits in `text`
    norm: list[str] = []
    pos: list[int] = []
    prev_space = False
    for i, ch in enumerate(text):
        if ch.isspace():
            if prev_space:
                continue
            prev_space = True
            norm.append(" ")
        else:
            prev_space = False
            norm.append(ch)
        pos.append(i)
    flat = "".join(norm)
    n = len(flat)
    cands = []
    for i in range(n):
        node = _trie.get(flat[i])
        if node is None:
            continue
        prev_letter = i > 0 and _LETTER_RE.match(flat[i - 1]) is not None
        for j in range(i, n):
            if j > i:
                node = node.get(flat[j])
                if node is None:
                    break
            key = node.get("$")
            if key is None:
                continue
            if _HEAD.match(key[0]) and prev_letter:
                continue
            if _HEAD.match(key[-1]) and j + 1 < n and _LETTER_RE.match(flat[j + 1]):
                continue
            cands.append((i, j + 1, _phrases[key]))
    if not cands:
        return text
    cands.sort(key=lambda c: (-(c[1] - c[0]), c[0]))
    taken: list[tuple[int, int, str]] = []
    for c in cands:
        if all(c[0] >= t[1] or t[0] >= c[1] for t in taken):
            taken.append(c)
    taken.sort()
    out = []
    last = 0
    for start, end, en in taken:
        a = pos[start]
        b = pos[end - 1] + 1
        out.append(text[last:a])
        out.append(en)
        last = b
    out.append(text[last:])
    return "".join(out).replace("«", '"').replace("»", '"')


def translate_blueprint(obj):
    """Переводит `label` и `description` блюпринта (и книги блюпринтов) на месте."""
    if not is_en():
        return obj
    if isinstance(obj, dict):
        for key in ("label", "description"):
            if isinstance(obj.get(key), str):
                obj[key] = tr(obj[key])
        for key, value in obj.items():
            if key not in ("entities", "tiles", "wires", "icons") and isinstance(value, (dict, list)):
                translate_blueprint(value)
    elif isinstance(obj, list):
        for value in obj:
            if isinstance(value, (dict, list)):
                translate_blueprint(value)
    return obj
