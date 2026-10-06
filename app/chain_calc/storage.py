"""Хранилище: датасеты (файлами) и цепочки (в SQLite) — у каждого кабинета свои.

Раньше всё лежало в общих папках: `data/datasets/*.json` и один `data/chains.json`
на всех. Теперь, когда сайт стоит в интернете, у каждого кабинета своя папка
`data/users/<номер>/{datasets,geometry,icons}`, а цепочки — строки в таблице
`chains` с `user_id` (см. chain_calc/accounts.py).

Кабинет берётся из контекста запроса (его кладёт туда middleware), поэтому
`load_dataset("2026-09-19")` сам находит файл нужного игрока. Если кабинетов нет
вовсе (режим `CHAIN_CALC_AUTH=0`, отладка) — работает как раньше, общими папками.
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Optional

from . import accounts

DATA_DIR = accounts.DATA_DIR
DATASETS_DIR = DATA_DIR / "datasets"
CHAINS_FILE = DATA_DIR / "chains.json"
# Отметка «старые данные уже перенесены» лежит рядом с базой: у тестов база в
# своей папке, значит и отметка тоже — рабочая папка остаётся нетронутой.
MIGRATION_MARKER = accounts.DB_PATH.parent / ".legacy_migrated"

DATASETS_DIR.mkdir(parents=True, exist_ok=True)
if not CHAINS_FILE.exists():
    CHAINS_FILE.write_text("{}", encoding="utf-8")


def _user_id(user_id: Optional[int]) -> Optional[int]:
    """Явный кабинет, иначе — кабинет текущего запроса, иначе None (общий режим)."""
    if user_id is not None:
        return int(user_id)
    return accounts.current_user_id()


# ---- датасеты ----

def datasets_dir(user_id: Optional[int] = None) -> Path:
    uid = _user_id(user_id)
    if uid is None:
        return DATASETS_DIR
    path = accounts.user_datasets_dir(uid)
    path.mkdir(parents=True, exist_ok=True)
    return path


def dataset_path(dataset_id: str, user_id: Optional[int] = None) -> Path:
    return datasets_dir(user_id) / f"{dataset_id}.json"


def save_dataset(dataset_id: str, data: dict, user_id: Optional[int] = None) -> Path:
    path = dataset_path(dataset_id, user_id)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    uid = _user_id(user_id)
    if uid is not None:
        accounts.register_dataset(uid, dataset_id, path, data, source="upload")
    return path


def load_dataset(dataset_id: str, user_id: Optional[int] = None) -> Optional[dict]:
    path = dataset_path(dataset_id, user_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def list_datasets(user_id: Optional[int] = None) -> list[str]:
    return sorted(p.stem for p in datasets_dir(user_id).glob("*.json"))


def delete_dataset(dataset_id: str, user_id: Optional[int] = None) -> None:
    path = dataset_path(dataset_id, user_id)
    if path.exists():
        path.unlink()
    uid = _user_id(user_id)
    if uid is not None:
        accounts.forget_dataset(uid, dataset_id)


# ---- цепочки ----

def _read_chains() -> dict:
    return json.loads(CHAINS_FILE.read_text(encoding="utf-8"))


def _write_chains(obj: dict) -> None:
    CHAINS_FILE.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def save_chain(chain_id: str, chain: dict, user_id: Optional[int] = None) -> None:
    uid = _user_id(user_id)
    if uid is None:
        chains = _read_chains()
        chains[chain_id] = {**chain, "updated_at": _now_ms()}
        _write_chains(chains)
        return
    stamp = _now_ms()
    with accounts.connect() as conn:
        conn.execute(
            "INSERT INTO chains (id, user_id, name, dataset_id, solver, tree, final_key, created_at, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET name=excluded.name, dataset_id=excluded.dataset_id,"
            " solver=excluded.solver, tree=excluded.tree, final_key=excluded.final_key,"
            " updated_at=excluded.updated_at",
            (
                chain_id, uid, chain.get("name"), chain.get("datasetId"),
                chain.get("solver") or "cascade",
                json.dumps(chain.get("tree") or {}, ensure_ascii=False),
                chain_final_key(chain), stamp, stamp,
            ),
        )


def load_chain(chain_id: str, user_id: Optional[int] = None) -> Optional[dict]:
    uid = _user_id(user_id)
    if uid is None:
        return _read_chains().get(chain_id)
    with accounts.connect() as conn:
        row = conn.execute(
            "SELECT * FROM chains WHERE id = ? AND user_id = ?", (chain_id, uid)
        ).fetchone()
    if row is None:
        return None
    return {
        "name": row["name"],
        "datasetId": row["dataset_id"],
        "solver": row["solver"],
        "tree": json.loads(row["tree"]),
        "updated_at": row["updated_at"],
    }


def list_chains(user_id: Optional[int] = None) -> list[dict]:
    uid = _user_id(user_id)
    if uid is None:
        chains = _read_chains()
        return [
            {
                "id": cid,
                "name": c.get("name"),
                "datasetId": c.get("datasetId"),
                "updated_at": c.get("updated_at"),
                # The chain's FIRST final product - the client uses it to decide
                # whether "Сохранить" updates this chain or creates a new one, so
                # saving a different recipe can never overwrite an unrelated save.
                "finalKey": chain_final_key(c),
            }
            for cid, c in chains.items()
        ]
    with accounts.connect() as conn:
        rows = conn.execute(
            "SELECT id, name, dataset_id, updated_at, final_key FROM chains"
            " WHERE user_id = ? ORDER BY updated_at DESC",
            (uid,),
        ).fetchall()
    return [
        {
            "id": row["id"],
            "name": row["name"],
            "datasetId": row["dataset_id"],
            "updated_at": row["updated_at"],
            "finalKey": row["final_key"],
        }
        for row in rows
    ]


def chain_final_key(chain: dict) -> Optional[str]:
    """Primary product of the first tab's root recipe (None for empty/legacy junk)."""
    tree = chain.get("tree") or {}
    root = None
    tabs = tree.get("tabs") or []
    if tabs:
        cascade = (tabs[0] or {}).get("cascade") or {}
        root = cascade.get("root")
    if not root:  # old single-tab save format
        cascade = tree.get("cascade") or {}
        root = cascade.get("root")
    if isinstance(root, dict):
        return root.get("primaryProduct")
    return None


def delete_chain(chain_id: str, user_id: Optional[int] = None) -> None:
    uid = _user_id(user_id)
    if uid is None:
        chains = _read_chains()
        chains.pop(chain_id, None)
        _write_chains(chains)
        return
    with accounts.connect() as conn:
        conn.execute("DELETE FROM chains WHERE id = ? AND user_id = ?", (chain_id, uid))


# ---- перенос старых данных в первый кабинет ----

def legacy_data_exists() -> bool:
    if list_datasets():
        return True
    return bool(_read_chains())


def migrate_legacy_into(user_id: int) -> dict:
    """Переносит общие датасеты и цепочки в кабинет (один раз, для первого).

    Так у себя на компьютере игрок не теряет уже сделанные цепочки и дампы:
    создал кабинет — и всё это оказалось в нём. Общие папки НЕ удаляются: если
    что-то пойдёт не так, данные останутся на месте.
    """
    if MIGRATION_MARKER.exists():
        return {"datasets": 0, "chains": 0, "skipped": True}
    accounts.init_db()
    accounts.ensure_user_dirs(user_id)
    target = accounts.user_datasets_dir(user_id)

    moved_datasets = 0
    for path in sorted(DATASETS_DIR.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        dst = target / path.name
        shutil.copyfile(path, dst)
        accounts.register_dataset(user_id, path.stem, dst, data, source="перенос")
        moved_datasets += 1

    moved_chains = 0
    if CHAINS_FILE.exists():
        try:
            chains = _read_chains()
        except (OSError, ValueError):
            chains = {}
        stamp = _now_ms()
        with accounts.connect() as conn:
            for chain_id, chain in chains.items():
                conn.execute(
                    "INSERT OR IGNORE INTO chains"
                    " (id, user_id, name, dataset_id, solver, tree, final_key, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        chain_id, user_id, chain.get("name"), chain.get("datasetId"),
                        chain.get("solver") or "cascade",
                        json.dumps(chain.get("tree") or {}, ensure_ascii=False),
                        chain_final_key(chain), stamp, chain.get("updated_at") or stamp,
                    ),
                )
                moved_chains += 1

    MIGRATION_MARKER.write_text(
        json.dumps({"user_id": user_id, "at": _now_ms()}, ensure_ascii=False), encoding="utf-8"
    )
    return {"datasets": moved_datasets, "chains": moved_chains, "skipped": False}


def _now_ms() -> int:
    import time

    return int(time.time() * 1000)
