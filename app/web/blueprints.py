"""Чертежи: блок завода, сундук по чужому чертежу, «сборщики всего», список закупки, чертёж цепочки.

Все ручки одинаково устроены: проверяют, что есть геометрия построек, собирают чертёж генератором
(`blueprint_gen`, `mall_gen`) и отвечают строкой чертежа плюс разбором (замечания, размеры, счётчики).
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

router = APIRouter()


class BlueprintRequest(BaseModel):
    datasetId: str
    machine: str
    recipe: Optional[str] = None
    count: int = 1
    groups: Optional[List[int]] = None
    # Сколько лент подачи нужно — считает КАЛЬКУЛЯТОР (его план подачи);
    # если не передали, смотрим по числу твёрдых входов рецепта.
    inputBelts: Optional[int] = None
    modules: Dict[str, int] = {}
    belt: str = "transport-belt"
    # Имя манипулятора приходит из раздела «Манипуляторы» на сайте. null означает
    # «числа манипуляторов неизвестны» (полный дамп без правок): тогда генератор
    # не ставит их вовсе и пишет об этом в описании чертежа, а не угадывает.
    inserterIn: Optional[str] = "inserter"
    inserterOut: Optional[str] = "inserter"
    # Сколько манипуляторов нужно одному заводу с каждой стороны (считает сайт
    # по таблице «пачка и скорость»): медленный один поток не вытягивает.
    inserterInCount: int = 1
    inserterOutCount: int = 1
    # Вход ПО ЛЕНТАМ: у каждой ленты подачи свой манипулятор и своё число
    # ([{"name": "mdrn-loader", "count": 1}, ...], порядок — от ближней к дальней).
    # Сайт считает ленты отдельно, и на одной ленте бывает погрузчик, а на другой
    # механический манипулятор: одним именем на весь вход это не выразить.
    inserterInRows: Optional[List[Dict[str, Any]]] = None
    pole: Optional[str] = None
    stub: int = 3
    label: str = ""
    # Куда едет лента выгрузки относительно лент подачи: "same" — в ту же сторону
    # (вход и выход подключаются с одного конца блока, по умолчанию),
    # "opposite" — в другую сторону (подача на север, выгрузка на юг).
    beltSides: str = "same"
    # Топливо завода: пепел от него едет лентой выгрузки.
    fuel: Optional[str] = None
    # Сколько групп в каждом ряду блока: [5, 5, 5] — три ряда по пять групп. Пусто — все
    # группы в один ряд. Сумма должна совпасть с числом групп этапа, иначе генератор
    # вернёт ошибку текстом.
    rowGroups: Optional[List[int]] = None
    # Маяков в блоке нет: они считаются на сайте (эффект заводов) и в сундуке запроса
    # (/api/shopping_list, поле beacons этапа).


def _count_poles(obj: dict) -> int:
    import blueprint as bp

    return sum(1 for e in bp.iter_entities(obj)
               if (bp.entity_record(e.get("name")) or {}).get("type") == "electric-pole")


def _default_pole() -> Optional[str]:
    """Столб по умолчанию — из ГЕОМЕТРИИ, а не из датасета.

    Мод выгружает только заводы и «поддержку» (ленты, манипуляторы, маяки), а
    столбов в датасете нет вовсе. Поэтому выбираем здесь: сначала средний, потом
    обычные, иначе первый попавшийся электрический столб.
    """
    import blueprint as bp

    records = bp.entity_records()
    poles = [name for name, rec in records.items() if rec.get("type") == "electric-pole"]
    if not poles:
        return None
    preferred = ["bob-medium-electric-pole-2", "medium-electric-pole", "big-electric-pole", "substation"]
    for name in preferred:
        if name in poles:
            return name
    return sorted(poles)[0]


def _with_default_pole(stages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Этапам без явного столба подставляет столб по умолчанию.

    Столбов нет в датасете (мод их не выгружает), поэтому клиент, который не
    знает геометрию, иначе получил бы цепочку без электричества вовсе.
    """
    pole = _default_pole()
    if not pole:
        return stages
    out = []
    for stage in stages:
        row = dict(stage)
        if not row.get("pole"):
            row["pole"] = pole
        out.append(row)
    return out


@router.post("/api/blueprint")
def make_blueprint(req: BlueprintRequest):
    """Собирает блюпринт блока по данным этапа цепочки.

    Трубы в блоке не ставятся: тайлы под газ и жидкость только резервируются, а
    проверка (fluidProblems) говорит, если что-то из них всё-таки занято.
    """
    try:
        import blueprint as bp
        import blueprint_gen as gen
    except ImportError as exc:  # pragma: no cover — на нормальной установке не бывает
        raise HTTPException(500, f"генератор недоступен: {exc}")

    if not bp.geometry_path():
        raise HTTPException(400, "нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    if req.count < 1:
        raise HTTPException(400, "нужен хотя бы один завод")

    pole = req.pole or _default_pole()
    spec = gen.BlockSpec(machine=req.machine, recipe=req.recipe, count=req.count,
                         groups=req.groups, input_belts=req.inputBelts,
                         row_groups=req.rowGroups,
                         modules=dict(req.modules or {}), belt=req.belt,
                         inserter_in=req.inserterIn, inserter_out=req.inserterOut,
                         inserter_in_rows=req.inserterInRows,
                         inserter_in_count=max(1, int(req.inserterInCount or 1)),
                         inserter_out_count=max(1, int(req.inserterOutCount or 1)),
                         pole=pole, stub=req.stub, label=req.label,
                         belt_sides=req.beltSides, fuel=req.fuel, dataset_id=req.datasetId)
    try:
        obj = gen.generate_sandwich_block(spec)
        string = bp.encode_string(obj)
    except (ValueError, KeyError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    plan = gen.block_plan(spec)
    problems = bp.validate(obj)
    fluid_problems = gen.check_fluid_access(obj)
    reservation = plan["reservation"]
    groups = [int(g) for g in (req.groups or []) if int(g) > 0] or [req.count]
    return {
        "string": string,
        "label": bp.blueprint_of(obj).get("label", ""),
        "entityCount": len(bp.iter_entities(obj)),
        "groups": groups,
        "pole": pole,
        "poles": _count_poles(obj),
        "rotation": plan["direction"],
        "rotationNote": plan["rotation"].get("note", ""),
        "consumers": sum(1 for e in bp.iter_entities(obj) if gen.needs_power(e["name"])),
        "portTiles": reservation.get("port_tiles", []),
        "reservedTiles": reservation.get("tiles", []),
        "fluids": reservation.get("fluids", {}),
        "unreachable": reservation.get("unreachable", []),
        "summary": bp.layout_summary(obj),
        "problems": [p["text"] for p in problems],
        "fluidProblems": [p["text"] for p in fluid_problems],
    }


class BlueprintChestRequest(BaseModel):
    # Строка блюпринта, вставленная пользователем.
    string: str
    datasetId: Optional[str] = None
    label: Optional[str] = None


@router.post("/api/chest_for_blueprint")
def make_chest_for_blueprint(req: BlueprintChestRequest):
    """Сундук запроса на всё, что нужно для вставленного чертежа.

    Разбираем строку, считаем постройки и модули внутри них, отвечаем списком
    предметов и готовой строкой сундука — её интерфейс сразу кладёт в буфер.
    """
    try:
        import blueprint as bp
        import blueprint_gen as gen
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(500, f"генератор недоступен: {exc}")
    if not bp.geometry_path():
        raise HTTPException(400, "нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    text = (req.string or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"error": "вставь строку блюпринта"})
    try:
        obj = bp.decode_string(text)
    except Exception as exc:  # noqa: BLE001 — мусор во вставке, а не наша ошибка
        return JSONResponse(status_code=400, content={
            "error": "не разобрал блюпринт: проверь, что строка скопирована целиком "
                     f"и начинается с «0e…» ({exc})",
        })

    entities = gen.blueprint_entities(obj)
    if not entities:
        return JSONResponse(status_code=400, content={
            "error": "в этом чертеже нет построек (только тайлы или пустая строка)",
        })

    try:
        data = gen.chest_for_blueprint(obj, dataset_id=req.datasetId, label=req.label)
        string = bp.encode_string(data["chest"])
    except (ValueError, KeyError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    notes = []
    if data["dropped"]:
        notes.append("в запрос не попали предметы, которых нет в датасете: "
                     + ", ".join(data["dropped"]))
    if data["unknown"]:
        notes.append("не понял, чем ставится: " + ", ".join(data["unknown"]))
    return {
        "string": string,
        "label": bp.blueprint_of(data["chest"]).get("label", ""),
        "items": data["items"],
        "positions": len(data["items"]),
        "entities": data["entities"],
        "totalEntities": data["total_entities"],
        "notes": notes,
    }


class ChainBlueprintRequest(BaseModel):
    datasetId: str
    stages: List[Dict[str, Any]] = []
    inserter: str = "inserter"


class MallBlueprintRequest(BaseModel):
    datasetId: str
    # Сколько автоматов в СТОЛБЦЕ (группы идут как вкладки крафта, столбцы
    # группы стоят подряд), какой длины строку допускаем в одной части
    # и во сколько раз умножать ингредиенты в сундуке запроса.
    perRow: int = 20
    maxChars: int = 4000
    multiplier: int = 4


# Куда класть готовые строки: их удобно перетащить файлом в окно игры, если
# вставка длинной строки не проходит (в окне импорта есть предел длины).
GENERATED_DIR = Path(__file__).resolve().parent.parent.parent / "generated"


@router.post("/api/mall_blueprint")
def make_mall_blueprint(req: MallBlueprintRequest):
    """Чертежи «сборщики всего»: по автомату на каждый рецепт, который делает постройку.

    У каждого автомата ПОД ним два манипулятора и два сундука: слева запроса (что
    нужно автомату), справа снабжения (что он сделал). Автоматы разложены по
    группам меню крафта: группа — вкладка в игре, у каждой свой участок столбцов
    (по 20 автоматов в столбце), между группами 7 клеток. Берём из дампа все
    рецепты построек: заводы, столбы, ленты, сундуки, манипуляторы, печи…
    Ресурсы и промежуточные материалы сюда не попадают — их делает основное
    производство.

    Отдаём ДВА вида:
      * `whole` — весь молл одной строкой (~130 КБ): её в окно импорта не вставить,
        зато файл можно перетащить прямо в игру;
      * `chunks` — части, каждая не длиннее `maxChars`: их можно вставлять по одной.
    """
    try:
        import blueprint as bp
        import mall_gen
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(500, f"генератор недоступен: {exc}")
    if not bp.geometry_path():
        raise HTTPException(400, "нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    pole = _default_pole()
    try:
        data = mall_gen.build_mall(req.datasetId, per_row=max(1, int(req.perRow)),
                                   max_chars=max(1, int(req.maxChars)),
                                   multiplier=max(1, int(req.multiplier)), pole=pole)
        whole = mall_gen.build_mall(req.datasetId, per_row=max(1, int(req.perRow)),
                                    per_chunk=None, max_chars=None,
                                    multiplier=max(1, int(req.multiplier)),
                                    pole=pole)["chunks"][0]
    except (ValueError, KeyError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    try:
        GENERATED_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:  # pragma: no cover — папка может быть недоступна на запись
        pass

    def write_file(name: str, string: str) -> str:
        try:
            (GENERATED_DIR / name).write_text(string, encoding="utf-8")
            return f"generated/{name}"
        except OSError:  # pragma: no cover
            return ""

    def chunk_payload(chunk: dict, name: str) -> dict:
        string = bp.encode_string(chunk["blueprint"])
        return {
            "index": chunk.get("index", 1),
            "total": chunk.get("total", 1),
            "label": chunk["label"],
            "string": string,
            "chars": len(string),
            "file": write_file(name, string),
            "first": chunk.get("first", 1),
            "last": chunk.get("last", chunk["recipes"]),
            "recipes": chunk["recipes"],
            "entities": chunk["entities"],
            "size": {"width": chunk["width"], "height": chunk["height"]},
            "summary": bp.blueprint_of(chunk["blueprint"]).get("description", ""),
            "problems": [p["text"] for p in bp.validate(chunk["blueprint"])],
        }

    chunks = [chunk_payload(chunk, f"mall-sborshchiki-{chunk['index']}-{chunk['total']}.txt")
              for chunk in data["chunks"]]
    return {
        "whole": chunk_payload(whole, "mall-sborshchiki-ves.txt"),
        "chunks": chunks,
        "chunkCount": len(chunks),
        "maxChars": req.maxChars,
        "recipes": data["recipes"],
        "entities": data["entities"],
        "perMachine": data["perMachine"],
        "withFluids": data["withFluids"],
    }


class ShoppingRequest(BaseModel):
    datasetId: str
    stages: List[Dict[str, Any]] = []
    # Имя цепочки с сайта — попадает в название чертежа, чтобы в игре было видно,
    # к какой цепочке сундук относится.
    label: Optional[str] = None
    # Как показывать предметы в описании чертежа: {имя: название на сайте}.
    itemNames: Optional[Dict[str, str]] = None


@router.post("/api/shopping_list")
def make_shopping_list(req: ShoppingRequest):
    """Что нужно, чтобы отстроить цепочку, и сундук запроса с этим списком.

    Считаются СТРОЙМАТЕРИАЛЫ (заводы, ленты, манипуляторы, столбы, модули), а не
    сырьё: блоки этапов собираются тем же генератором, что и кнопка «Блюпринт».
    """
    try:
        import blueprint as bp
        import blueprint_gen as gen
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(500, f"генератор недоступен: {exc}")
    if not bp.geometry_path():
        raise HTTPException(400, "нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    if not req.stages:
        return JSONResponse(status_code=400, content={"error": "нет этапов"})
    try:
        stages = _with_default_pole(req.stages)
        try:
            data = gen.build_list(stages, dataset_id=req.datasetId)
        except Exception as exc:   # noqa: BLE001 — сундук нужен даже при поломке раскладки
            # Запасной путь: только заводы и манипуляторы, зато сундук создаётся.
            data = gen.build_minimal_list(stages, dataset_id=req.datasetId)
            data["notes"] = [f"раскладка не собралась ({exc})"] + list(data.get("notes") or [])
        chest = gen.shopping_chest(data["items"], label=req.label,
                                   item_names=req.itemNames)
        string = bp.encode_string(chest)
    except (ValueError, KeyError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return {
        "string": string,
        "items": data["items"],
        "positions": len(data["items"]),
        "notes": data.get("notes", []),
        "partial": bool(data.get("partial")),
        "label": bp.blueprint_of(chest).get("label", ""),
    }


@router.post("/api/blueprint_chain")
def make_chain_blueprint(req: ChainBlueprintRequest):
    """Чертёж ВСЕЙ цепочки на сундуках запроса.

    Каждый этап — свой ряд: сундук запроса (в нём выставлено, что этапу нужно),
    манипулятор, заводы, манипулятор, сундук-поставщик. Продукция уезжает в
    логистику, поэтому следующий этап запросит её сам.
    """
    try:
        import blueprint as bp
        import blueprint_gen as gen
    except ImportError as exc:  # pragma: no cover
        raise HTTPException(500, f"генератор недоступен: {exc}")
    if not bp.geometry_path():
        raise HTTPException(400, "нет файла геометрии — сделай дамп: сделать дамп геометрии.bat")
    if not req.stages:
        return JSONResponse(status_code=400, content={"error": "нет этапов для чертежа"})
    try:
        obj = gen.chain_blueprint(req.stages, dataset_id=req.datasetId, inserter=req.inserter)
        string = bp.encode_string(obj)
    except (ValueError, KeyError) as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})
    return {
        "string": string,
        "label": bp.blueprint_of(obj).get("label", ""),
        "entityCount": len(bp.iter_entities(obj)),
        "stages": len(req.stages),
        "problems": [p["text"] for p in bp.validate(obj)],
        "summary": bp.blueprint_of(obj).get("description", ""),
    }
