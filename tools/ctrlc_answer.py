"""Фоновый помощник батников запуска: сам отвечает «Y» на вопрос cmd «Завершить выполнение пакетного файла?».

Когда сервер останавливают по Ctrl+C, cmd после выхода программы спрашивает «Terminate batch job (Y/N)?» и ждёт
нажатия. Батник запускает этот скрипт в фоне (`start "" /b python tools\\ctrlc_answer.py`): он видит то же
нажатие Ctrl+C, выжидает, пока сервер выйдет и вопрос появится, и «нажимает» Y. Пока Ctrl+C не нажимали, он
ничего не делает и сам завершается, когда завершается батник (родительский cmd).
"""
from __future__ import annotations

import ctypes
import ctypes.wintypes as wt
import os
import signal
import sys
import time

if os.name != "nt":
    sys.exit(0)

kernel32 = ctypes.windll.kernel32
# `start /b` запускает программу с выключенным Ctrl+C — включаем обработку обратно, чтобы увидеть то же нажатие
kernel32.SetConsoleCtrlHandler(None, False)


class _Entry(ctypes.Structure):
    _fields_ = [("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wt.DWORD), ("cntThreads", wt.DWORD),
                ("th32ParentProcessID", wt.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wt.DWORD),
                ("szExeFile", ctypes.c_wchar * 260)]


def batch_shell_pid() -> int:
    """Процесс cmd, который читает батник: у запуска через лаунчер `py` между нами и cmd стоит ещё py.exe."""
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)
    table: dict = {}
    entry = _Entry()
    entry.dwSize = ctypes.sizeof(_Entry)
    ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
    while ok:
        table[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
        ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    kernel32.CloseHandle(snapshot)
    pid = os.getpid()
    for _ in range(6):
        parent = table.get(pid, (0, ""))[0]
        if not parent:
            break
        if table.get(parent, (0, ""))[1] == "cmd.exe":
            return parent
        pid = parent
    return os.getppid()


PARENT = batch_shell_pid()
WAIT_BEFORE_ANSWER = 1.0      # сколько ждать после Ctrl+C: сервер выходит, и только потом появляется вопрос
SYNCHRONIZE = 0x00100000
WAIT_TIMEOUT = 0x102


class _Key(ctypes.Structure):
    _fields_ = [("bKeyDown", wt.BOOL), ("wRepeatCount", wt.WORD), ("wVirtualKeyCode", wt.WORD),
                ("wVirtualScanCode", wt.WORD), ("uChar", wt.WCHAR), ("dwControlKeyState", wt.DWORD)]


class _Record(ctypes.Structure):
    class _Union(ctypes.Union):
        _fields_ = [("KeyEvent", _Key)]
    _anonymous_ = ("u",)
    _fields_ = [("EventType", wt.WORD), ("u", _Union)]


def answer_yes() -> None:
    """Кладёт в очередь ввода консоли нажатия «Y» и Enter."""
    handle = kernel32.CreateFileW("CONIN$", 0xC0000000, 3, None, 3, 0, None)
    records = []
    for char in "Y\r":
        code = 0x0D if char == "\r" else ord(char)
        for down in (1, 0):
            record = _Record()
            record.EventType = 1
            record.KeyEvent = _Key(down, 1, code, 0, char, 0)
            records.append(record)
    batch = (_Record * len(records))(*records)
    written = wt.DWORD(0)
    kernel32.WriteConsoleInputW(handle, batch, len(records), ctypes.byref(written))
    kernel32.CloseHandle(handle)


def parent_alive() -> bool:
    handle = kernel32.OpenProcess(SYNCHRONIZE, False, PARENT)
    if not handle:
        return False
    alive = kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
    kernel32.CloseHandle(handle)
    return alive


def main() -> None:
    hit: list = []
    signal.signal(signal.SIGINT, lambda *_: hit.append(time.time()) if not hit else None)
    next_try = None
    while parent_alive():
        now = time.time()
        if hit and next_try is None:
            next_try = hit[0] + WAIT_BEFORE_ANSWER
        if next_try is not None and now >= next_try:
            answer_yes()
            next_try = now + 1.0          # вопрос мог ещё не появиться: пробуем снова, пока батник не завершится
        time.sleep(0.1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
