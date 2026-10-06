"""Расчёт цепочки: каскад и матричный решатель."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from chain_calc import storage
from chain_calc.solver import SolverError, solve_cascade, solve_matrix
from . import core

router = APIRouter()


class SolveRequest(BaseModel):
    datasetId: str
    mode: str  # "cascade" | "matrix"
    root: Optional[Dict[str, Any]] = None
    targetRate: Optional[float] = None
    rows: Optional[List[Dict[str, Any]]] = None
    objectives: Optional[Dict[str, float]] = None


@router.post("/api/solve")
def solve(req: SolveRequest):
    dataset = storage.load_dataset(req.datasetId, user_id=core.scope_user_id())
    if dataset is None:
        raise HTTPException(404, "нет такого датасета в этом кабинете")
    try:
        if req.mode == "cascade":
            if not req.root or req.targetRate is None:
                raise HTTPException(400, "root and targetRate required")
            return solve_cascade(req.root, req.targetRate, dataset)
        if req.mode == "matrix":
            if req.rows is None or req.objectives is None:
                raise HTTPException(400, "rows and objectives required")
            return solve_matrix(req.rows, req.objectives, dataset)
        raise HTTPException(400, "mode must be 'cascade' or 'matrix'")
    except SolverError as e:
        return JSONResponse(status_code=400, content={"error": str(e)})
