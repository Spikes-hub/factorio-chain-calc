"""Сохранённые цепочки (у каждого кабинета свои)."""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from chain_calc import storage
from . import core

router = APIRouter()


class ChainIn(BaseModel):
    name: Optional[str] = None
    datasetId: str
    solver: Optional[str] = "cascade"
    tree: Dict[str, Any]


@router.post("/api/chains")
def create_chain(chain: ChainIn):
    uid = core.scope_user_id()
    chain_id = core.new_id()
    storage.save_chain(chain_id, chain.model_dump(), user_id=uid)
    return {"id": chain_id, "url": f"/?chain={chain_id}"}


@router.put("/api/chains/{chain_id}")
def update_chain(chain_id: str, chain: ChainIn):
    uid = core.scope_user_id()
    existing = storage.load_chain(chain_id, user_id=uid)
    if existing is None:
        raise HTTPException(404, "нет такой цепочки в этом кабинете")
    storage.save_chain(chain_id, chain.model_dump(), user_id=uid)
    return {"id": chain_id}


@router.get("/api/chains")
def get_chains():
    return storage.list_chains(user_id=core.scope_user_id())


@router.get("/api/chains/{chain_id}")
def get_chain(chain_id: str):
    uid = core.scope_user_id()
    chain = storage.load_chain(chain_id, user_id=uid)
    if chain is None:
        raise HTTPException(404, "нет такой цепочки в этом кабинете")
    return {"id": chain_id, **chain}


@router.delete("/api/chains/{chain_id}")
def remove_chain(chain_id: str):
    uid = core.scope_user_id()
    storage.delete_chain(chain_id, user_id=uid)
    return {"ok": True}
