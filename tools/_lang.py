"""Language of the console messages of the tools: Russian if Windows is Russian, else English.

CHAIN_CALC_LANG=ru|en forces the choice. Shared by make_dump.py and upload_to_server.py.
"""
from __future__ import annotations

import os
import sys


def _russian() -> bool:
    forced = (os.environ.get("CHAIN_CALC_LANG") or "").lower()
    if forced:
        return forced.startswith("ru")
    try:
        import ctypes
        return (ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF) == 0x19
    except Exception:  # noqa: BLE001 - not Windows or no ctypes
        return False


RU = _russian()


def pick(en: str, ru: str = "") -> str:
    return ru if (RU and ru) else en


def say(en: str, ru: str = "") -> None:
    print(pick(en, ru), flush=True)


def utf8_console() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
