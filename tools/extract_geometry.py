r"""
extract_geometry.py — разовый локальный скрипт (запускать руками, не через сервер).

Собирает из «сырого» дампа игры компактный файл ГЕОМЕТРИИ, который нужен
генератору блюпринтов (и вообще всему, что должно знать, сколько места занимает
постройка и откуда у неё торчат трубы).

Откуда берётся сырой дамп:

    "C:\Program Files (x86)\Steam\steamapps\common\Factorio\bin\x64\factorio.exe" --dump-data

Игра открывается на секунду, выгружает data.raw в JSON и закрывается. Файл
складывается в script-output/data-raw-dump.json (у обычной установки это
%APPDATA%\Factorio\script-output, см. tools\dump_data.ps1 — он умеет писать
дамп прямо рядом с проектом) и весит ~80 МБ: там вся графика, звуки, иконки.
Из всего этого нам нужны только числа:

  * размер постройки в тайлах (tile_width/tile_height, иначе — из collision_box);
  * collision_box / selection_box (чтобы ничего не ставить друг на друга);
  * точки подключения труб: у каждой fluid box — список pipe_connections
    (позиция, направление, тип, фильтр по жидкости, максимальная длина подземной
    трубы). Это то, из-за чего вообще затевался весь дамп: по этим числам
    генератор понимает, где у завода вход/выход газа и жидкости, чтобы не
    поставить туда столб, ленту или манипулятор;
  * манипуляторы: скорость поворота, скорость выдвижения, размер руки,
    pickup_position / insert_position (достаёт ли он до ленты или до завода);
  * ленты/погрузчики/подземки: скорость, max_distance у подземки;
  * столбы/биконы: зона питания и длина провода.

Всё остальное (рецепты, предметы, скорости крафта, модули) уже есть в
chain-calc-dump.json — здесь только геометрия, поэтому файл получается
маленький (десятки-сотни КБ вместо 80 МБ).

Использование:
    python tools\extract_geometry.py ^
        --raw "%TEMP%\factorio-dsh\script-output\data-raw-dump.json" ^
        --out data\geometry\2026-09-19.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import sys
from pathlib import Path

# Типы прототипов-построек, которые вообще имеет смысл уметь ставить блюпринтом.
# Всё остальное (трупы, деревья, снаряды, юниты, тайлы) отбрасывается.
WANTED_TYPES = (
    "assembling-machine",
    "furnace",
    "mining-drill",
    "boiler",
    "generator",
    "burner-generator",
    "offshore-pump",
    "pump",
    "storage-tank",
    "pipe",
    "pipe-to-ground",
    "valve",
    "heat-pipe",
    "heat-interface",
    "reactor",
    "transport-belt",
    "underground-belt",
    "splitter",
    "lane-splitter",
    "loader",
    "loader-1x1",
    "linked-belt",
    "inserter",
    "electric-pole",
    "beacon",
    "lamp",
    "radar",
    "roboport",
    "container",
    "logistic-container",
    "accumulator",
    "solar-panel",
    "electric-energy-interface",
    "rocket-silo",
    "lab",
    "agricultural-tower",
    "asteroid-collector",
    "space-platform-hub",
)

# Типы, которые ставятся в завод (для них размер обязан быть точным).
FACTORY_TYPES = frozenset(WANTED_TYPES)

WANTED_TYPES = WANTED_TYPES + (
    # стены/рельсы/поезда/камни — не для завода, но нужны, чтобы разобрать и
    # проверить любой готовый блюпринт целиком, а не только «заводскую» часть
    "wall",
    "gate",
    "straight-rail",
    "curved-rail-a",
    "curved-rail-b",
    "half-diagonal-rail",
    "elevated-straight-rail",
    "elevated-curved-rail-a",
    "elevated-curved-rail-b",
    "elevated-half-diagonal-rail",
    "legacy-straight-rail",
    "legacy-curved-rail",
    "rail-signal",
    "rail-chain-signal",
    "rail-support",
    "rail-ramp",
    "train-stop",
    "locomotive",
    "cargo-wagon",
    "fluid-wagon",
    "artillery-wagon",
    "infinity-cargo-wagon",
    "entity-ghost",
    "tile-ghost",
    "item-request-proxy",
    "infinity-container",
    "infinity-pipe",
    "linked-container",
    "proxy-container",
    "temporary-container",
    "market",
    "cargo-landing-pad",
    "cargo-pod",
    "ammo-turret",
    "electric-turret",
    "fluid-turret",
    "artillery-turret",
    "power-switch",
    "programmable-speaker",
    "display-panel",
    "arithmetic-combinator",
    "decider-combinator",
    "constant-combinator",
    "selector-combinator",
    "land-mine",
    "tree",
    "simple-entity",
    "simple-entity-with-owner",
    "simple-entity-with-force",
    "cliff",
    "resource",
)

# Типы, которые рисуются как «сущность», но в фабрике не участвуют.
SKIP_NAMES = ("-remnants",)


def full_extent(box) -> tuple[float, float]:
    """Ширина/высота collision_box по x и y (collision_box — [[x1,y1],[x2,y2]])."""
    (x1, y1), (x2, y2) = box[0], box[1]
    return abs(x2 - x1), abs(y2 - y1)


def is_plain_box(box) -> bool:
    """[[x1,y1],[x2,y2]] — да; [[[..],[..]] x4] (вариант на поворот) — нет."""
    try:
        return isinstance(box[0][0], (int, float))
    except (TypeError, IndexError, KeyError):
        return False


def box_variants(box):
    """Возвращает список collision_box по поворотам (в 2.0 их может быть 4)."""
    if not box:
        return []
    if is_plain_box(box):
        return [box]
    # список из 4 (или 2) коробок
    out = []
    for item in box:
        if isinstance(item, list) and item and isinstance(item[0], list):
            out.append(item)
    return out


def tile_size_from_box(box) -> tuple[int, int]:
    """Размер в тайлах из collision_box.

    Factorio держит зазор 0.2 тайла с каждой стороны (2.4 у завода 3x3,
    4.8 у нефтезавода 5x5, 0.3 у манипулятора 1x1), поэтому размер — это
    ceil(полная ширина). Проверяется автотестом по тем прототипам, у которых
    игра сама написала tile_width/tile_height.
    """
    w, h = full_extent(box)
    # round перед ceil — чтобы 2.4000000000000004 не превратилось в 3 при 2.4
    return int(math.ceil(round(w, 6) - 1e-9)), int(math.ceil(round(h, 6) - 1e-9))


def as_xy(value):
    """Позиция из дампа: либо [x, y], либо {"x": .., "y": ..}."""
    if isinstance(value, dict):
        return [value.get("x"), value.get("y")]
    if isinstance(value, list) and len(value) >= 2:
        return [value[0], value[1]]
    return None


def place_item(proto: dict):
    """Название предмета, которым эта постройка ставится."""
    pb = proto.get("placeable_by")
    if isinstance(pb, dict) and pb.get("item"):
        return pb["item"]
    if isinstance(pb, list) and pb and isinstance(pb[0], dict):
        return pb[0].get("item")
    minable = proto.get("minable") or {}
    results = minable.get("results")
    if isinstance(results, list) and len(results) == 1 and isinstance(results[0], dict):
        if results[0].get("type") == "item":
            return results[0].get("name")
    if minable.get("result"):
        return minable["result"]
    return None


def compact_pipe_connection(conn: dict) -> dict:
    out = {}
    pos = as_xy(conn.get("position"))
    if pos is not None:
        out["pos"] = pos
    if conn.get("direction") is not None:
        out["dir"] = conn["direction"]
    if conn.get("flow_direction"):
        out["flow"] = conn["flow_direction"]
    if conn.get("connection_type"):
        out["type"] = conn["connection_type"]
    if conn.get("filter"):
        out["filter"] = conn["filter"]
    if conn.get("max_underground_distance") is not None:
        out["max_underground"] = conn["max_underground_distance"]
    cats = conn.get("connection_category") or conn.get("connection_categories")
    if cats:
        # в дампе категории дублируются (моды дописывают свои) — чистим
        seen, uniq = set(), []
        for c in cats if isinstance(cats, list) else [cats]:
            if c not in seen:
                seen.add(c)
                uniq.append(c)
        out["categories"] = uniq
    return out


def compact_fluid_box(box: dict) -> dict:
    out = {}
    if box.get("production_type"):
        out["production"] = box["production_type"]
    if box.get("volume") is not None:
        out["volume"] = box["volume"]
    conns = box.get("pipe_connections") or []
    if conns:
        out["pipes"] = [compact_pipe_connection(c) for c in conns if isinstance(c, dict)]
    if box.get("filter"):
        out["filter"] = box["filter"]
    return out


def fluid_boxes(proto: dict) -> list[dict]:
    boxes = proto.get("fluid_boxes")
    if isinstance(boxes, dict):  # старый одиночный fluid_box
        return [boxes]
    if isinstance(boxes, list):
        return [b for b in boxes if isinstance(b, dict)]
    single = proto.get("fluid_box")
    if isinstance(single, dict):
        return [single]
    return []


def compact_entity(proto: dict) -> dict | None:
    """Одна постройка -> компактная запись (или None, если это не постройка)."""
    if not isinstance(proto, dict):
        return None
    name = proto.get("name")
    if not name or any(name.endswith(s) for s in SKIP_NAMES):
        return None

    out: dict = {"type": proto.get("type")}

    # --- размер ---
    #
    # Основной источник — collision_box (у подавляющего большинства построек он
    # и даёт габарит: 2.4 -> 3 тайла у завода 3x3, 0.3 -> 1 у манипулятора).
    # Там, где постройка «нестандартная» (у вагона, ворот, Py-генератора габарит
    # шире коллизии), из collision_box и selection_box получаются разные числа —
    # второй размер пишем в size_alt, чтобы было видно и можно было перепроверить.
    size = None
    alt_size = None
    tw, th = proto.get("tile_width"), proto.get("tile_height")
    if isinstance(tw, int) and isinstance(th, int) and tw > 0 and th > 0:
        size = [tw, th]
        out["size_from"] = "tile_width"
    else:
        candidates = {}
        for field, label in (("collision_box", "collision_box"), ("selection_box", "selection_box")):
            variants = box_variants(proto.get(field))
            if not variants:
                continue
            candidate = list(tile_size_from_box(variants[0]))
            if candidate[0] < 1 or candidate[1] < 1:
                continue
            candidates[label] = (candidate, variants)
        if "collision_box" in candidates:
            size, variants = candidates["collision_box"]
            out["size_from"] = "collision_box"
            if len(variants) > 1:
                out["size_per_rotation"] = [list(tile_size_from_box(v)) for v in variants]
        elif "selection_box" in candidates:
            size, _ = candidates["selection_box"]
            out["size_from"] = "selection_box"
        if size is not None and "selection_box" in candidates:
            other = candidates["selection_box"][0]
            if other != size:
                alt_size = other
    if size is None:
        return None  # нечего ставить: ни размеров, ни коллизии
    out["size"] = size
    if alt_size:
        out["size_alt"] = alt_size

    cb = proto.get("collision_box")
    if cb:
        out["collision_box"] = cb if is_plain_box(cb) else [b for b in cb if isinstance(b, list)]
    sb = proto.get("selection_box")
    if sb and is_plain_box(sb):
        out["selection_box"] = sb
    if proto.get("flags"):
        out["flags"] = proto["flags"]
    item = place_item(proto)
    if item:
        out["item"] = item

    # --- трубы ---
    boxes = fluid_boxes(proto)
    compact = [compact_fluid_box(b) for b in boxes]
    # Завод на жидком топливе: вход топлива — отдельный fluid box источника энергии. Кладём его ПЕРВЫМ входом
    # с пометкой energy: тогда «i-я жидкость идёт в i-й вход» работает, если топливо поставить первой жидкостью.
    energy_box = (proto.get("energy_source") or {}).get("fluid_box")
    if (proto.get("energy_source") or {}).get("type") == "fluid" and isinstance(energy_box, dict):
        fuel = compact_fluid_box({**energy_box, "production_type": "input"})
        fuel["energy"] = True
        compact.insert(0, fuel)
    if compact:
        out["fluids"] = compact

    # --- манипулятор ---
    if proto.get("type") == "inserter" or proto.get("rotation_speed") is not None:
        ins = {}
        for src, dst in (
            ("rotation_speed", "rotation_speed"),
            ("extension_speed", "extension_speed"),
            ("hand_size", "hand_size"),
            ("pickup_position", "pickup"),
            ("insert_position", "insert"),
            ("stack_size_bonus", "stack_size_bonus"),
            ("uses_inserter_stack_size_bonus", "uses_stack_bonus_research"),
            ("bulk", "bulk"),
            ("filter_count", "filter_count"),
        ):
            if proto.get(src) is not None:
                val = as_xy(proto[src]) if src.endswith("position") else proto[src]
                ins[dst] = val
        energy = (proto.get("energy_source") or {}).get("type")
        if energy:
            ins["energy_source"] = energy
        if ins:
            out["inserter"] = ins

    # --- ленты и погрузчики ---
    etype = proto.get("type")
    if etype in ("transport-belt", "underground-belt", "splitter", "lane-splitter",
                 "loader", "loader-1x1", "linked-belt"):
        belt = {}
        if proto.get("speed") is not None:
            belt["speed"] = proto["speed"]
        if proto.get("max_distance") is not None:
            belt["max_underground_distance"] = proto["max_distance"]
        if proto.get("max_underground_distance") is not None:
            belt["max_underground_distance"] = proto["max_underground_distance"]
        out["belt"] = belt

    # --- электрика ---
    if etype in ("electric-pole", "beacon", "roboport", "radar"):
        el = {}
        for key in ("supply_area_distance", "maximum_wire_distance", "wire_reach_distance",
                    "distribution_effectivity", "energy_usage", "logistics_radius",
                    "construction_radius", "charging_energy"):
            if proto.get(key) is not None:
                el[key] = proto[key]
        if etype == "beacon" and proto.get("profile"):
            el["profile_len"] = len(proto["profile"])
        if el:
            out["electric"] = el

    # --- завод ---
    if etype in ("assembling-machine", "furnace", "rocket-silo", "lab", "mining-drill",
                 "boiler", "generator", "burner-generator", "reactor", "agricultural-tower"):
        m = {}
        if proto.get("crafting_speed") is not None:
            m["crafting_speed"] = proto["crafting_speed"]
        if proto.get("crafting_categories"):
            m["crafting_categories"] = proto["crafting_categories"]
        if proto.get("resource_categories"):
            m["resource_categories"] = proto["resource_categories"]
        if proto.get("allowed_effects"):
            m["allowed_effects"] = proto["allowed_effects"]
        if proto.get("module_slots") is not None:
            m["module_slots"] = proto["module_slots"]
        if proto.get("energy_source"):
            m["energy_source"] = (proto["energy_source"] or {}).get("type")
        if m:
            out["machine"] = m

    # --- выгрузка на ленту «своими руками» ---
    #
    # Часть построек кладёт продукт не манипулятором, а сама — на землю или ленту
    # перед собой. В прототипе это vector_to_place_result: вектор в тайлах от
    # центра постройки, который поворачивается ВМЕСТЕ с постройкой. Так работают
    # буры, Py-экстракторы (экстрактор грунта, бур земли, классификатор) и
    # литейные аппараты: манипулятор на выход им не нужен, зато тайл выгрузки
    # обязан быть свободен или занят лентой — иначе постройка встанет.
    #
    # Нулевой вектор (у насосных вышек, у которых продукт — жидкость) означает,
    # что выгружать на ленту нечего, поэтому его не пишем.
    drop = as_xy(proto.get("vector_to_place_result"))
    if drop and (abs(drop[0]) > 1e-6 or abs(drop[1]) > 1e-6):
        out["drops_to_belt"] = [drop[0], drop[1]]

    return out


def load_runtime_sizes(path: Path) -> dict:
    """Размеры построек из дампа сохранения (поле tile_width, dump_version >= 5).

    Возвращает {имя: (ширина, высота)}. Пустой словарь, если дамп старый.
    """
    try:
        with path.open(encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    out = {}
    for name, rec in (data.get("entities") or {}).items():
        if not isinstance(rec, dict):
            continue
        w, h = rec.get("tile_width"), rec.get("tile_height")
        if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
            out[name] = (w, h)
    return out


def find_runtime_sizes_source(root: Path) -> Path | None:
    """Свежайший дамп сохранения, в котором есть точные размеры построек."""
    datasets = root / "data" / "datasets"
    if not datasets.is_dir():
        return None
    for path in sorted(datasets.glob("*.json"), reverse=True):
        if load_runtime_sizes(path):
            return path
    return None


def apply_runtime_sizes(entities: dict, runtime: dict) -> list[dict]:
    """Перезаписывает размеры построек точными значениями из рантайма.

    В data-стадии (--dump-data) поля tile_width нет, поэтому размер выводится из
    collision_box и у «нестандартных» построек может отличаться на тайл. Если есть
    дамп сохранения с dump_version >= 5, берём размер оттуда — он и есть тот,
    которым игра решает, какие тайлы заняты.
    """
    changed = []
    for _ptype, bucket in entities.items():
        for name, rec in bucket.items():
            size = runtime.get(name)
            if not size:
                continue
            new_size = [int(size[0]), int(size[1])]
            if rec.get("size") != new_size:
                changed.append({"name": name, "was": rec.get("size"), "now": new_size})
            rec["size"] = new_size
            rec["size_from"] = "runtime"
            rec.pop("size_alt", None)
    return changed


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", required=True, help="Путь к data-raw-dump.json (из factorio.exe --dump-data)")
    ap.add_argument("--out", required=True, help="Куда положить компактный файл геометрии")
    ap.add_argument("--game-version", default="", help="Версия игры для справки (необязательно)")
    ap.add_argument("--sizes-from", default="auto",
                    help="Дамп сохранения с точными размерами (dump_version >= 5) "
                         "или 'auto' — взять свежайший из data/datasets; 'none' — не брать")
    ap.add_argument("--all", action="store_true",
                    help="Взять все типы с collision_box, а не только известные постройки")
    args = ap.parse_args()

    root = Path(__file__).resolve().parent.parent

    raw_path = Path(args.raw)
    if not raw_path.is_file():
        print(f"Нет файла дампа: {raw_path}", file=sys.stderr)
        return 2

    with raw_path.open(encoding="utf-8") as f:
        raw = json.load(f)

    wanted = None if args.all else set(WANTED_TYPES)

    entities: dict[str, dict] = {}
    stats = {"types": 0, "entities": 0, "with_fluids": 0, "size_from_tile": 0,
             "size_from_box": 0, "size_from_selection": 0}

    for ptype, protos in raw.items():
        if not isinstance(protos, dict):
            continue
        if wanted is not None and ptype not in wanted:
            continue
        bucket = {}
        for pname, proto in protos.items():
            rec = compact_entity(proto)
            if rec is None:
                continue
            rec["type"] = rec.get("type") or ptype
            bucket[pname] = rec
        if bucket:
            entities[ptype] = bucket
            stats["types"] += 1
            stats["entities"] += len(bucket)
            for rec in bucket.values():
                if rec.get("fluids"):
                    stats["with_fluids"] += 1
                src = rec.get("size_from")
                if src == "tile_width":
                    stats["size_from_tile"] += 1
                elif src == "collision_box":
                    stats["size_from_box"] += 1
                else:
                    stats["size_from_selection"] += 1

    # --- точные размеры из дампа сохранения (если он есть) ---
    runtime_source = None
    runtime_changed: list[dict] = []
    if args.sizes_from != "none":
        path = None if args.sizes_from == "auto" else Path(args.sizes_from)
        if path is None:
            path = find_runtime_sizes_source(root)
        elif not path.is_file():
            print(f"Нет файла с размерами: {path}", file=sys.stderr)
            path = None
        if path is not None:
            runtime = load_runtime_sizes(path)
            if runtime:
                runtime_source = path
                runtime_changed = apply_runtime_sizes(entities, runtime)

    # --- самопроверка формулы размера ---
    #
    # tile_width в дампе есть только у «обломков» (corpse), и у них он наследует
    # размер исходной постройки лишь приблизительно, поэтому проверяем иначе:
    # у настоящих построек размер считаем из collision_box, а сверяем с
    # selection_box — у всех ставящихся построек они дают одно и то же число
    # тайлов (проверено на assembling-machine-1 3x3, oil-refinery 5x5,
    # splitter 2x1, loader 1x2, py-biomass-powerplant 15x15 и т.д.).
    mismatches = []
    factory_mismatches = []
    checked = 0
    for ptype, bucket in entities.items():
        for pname, rec in bucket.items():
            cb, sb = rec.get("collision_box"), rec.get("selection_box")
            if not (cb and sb) or not (is_plain_box(cb) and is_plain_box(sb)):
                continue
            checked += 1
            from_cb = list(tile_size_from_box(cb))
            from_sb = list(tile_size_from_box(sb))
            if from_cb != from_sb:
                mismatches.append((ptype, pname, from_cb, from_sb))
                # для заводских построек расхождение важнее: у камней, деревьев и
                # вагонов collision_box честно меньше их «габарита»
                if ptype in FACTORY_TYPES:
                    factory_mismatches.append((ptype, pname, from_cb, from_sb))

    raw_bytes = raw_path.read_bytes()
    # --- вкладки меню крафта: имя группы -> её order
    #
    # Нужно моллу «сборщики всего»: он раскладывает автоматы по группам, и группы
    # должны идти в том же порядке, что вкладки в игре (у Py это «a», «t2», «v»…).
    # В датасете порядка групп нет, а в дампе он есть — кладём его сюда.
    groups: dict[str, dict] = {}
    for gname, gproto in (raw.get("item-group") or {}).items():
        if not isinstance(gproto, dict):
            continue
        groups[gname] = {
            "order": str(gproto.get("order") or ""),
            "name": gproto.get("name") or gname,
        }
    meta = {
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "source_file": raw_path.name,
        "source_size": len(raw_bytes),
        "source_sha1": hashlib.sha1(raw_bytes).hexdigest(),
        "source_mtime": dt.datetime.fromtimestamp(raw_path.stat().st_mtime).isoformat(timespec="seconds"),
        "game_version": args.game_version or "",
        "runtime_sizes": {
            "source": runtime_source.name if runtime_source else "",
            "applied": sum(1 for b in entities.values() for r in b.values()
                           if r.get("size_from") == "runtime"),
            "changed": runtime_changed,
        },
        "tile_size_check": {
            "checked": checked,
            "mismatches": len(mismatches),
            "factory_mismatches": len(factory_mismatches),
            "examples": factory_mismatches[:10],
        },
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump({"meta": meta, "groups": groups, "entities": entities},
                  f, ensure_ascii=False, separators=(",", ":"))

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"Готово: {out_path}  ({size_mb:.2f} МБ)")
    print(f"типов: {stats['types']}, построек: {stats['entities']}, с трубами: {stats['with_fluids']}")
    print(f"размер: из tile_width {stats['size_from_tile']}, "
          f"из collision_box {stats['size_from_box']}, "
          f"из selection_box {stats['size_from_selection']}")
    print(f"проверка формулы размера: сверено {checked} построек, расхождений {len(mismatches)} "
          f"(из них заводских {len(factory_mismatches)})")
    print(f"вкладок меню крафта (item-group) в файле: {len(groups)}")
    if runtime_source:
        print(f"точные размеры из рантайма: {runtime_source.name} — "
              f"подставлено у {meta['runtime_sizes']['applied']} построек, "
              f"исправлено {len(runtime_changed)}")
        for row in runtime_changed[:10]:
            print("    было/стало:", row["name"], row["was"], "->", row["now"])
    else:
        print("точных размеров из рантайма нет (нужен дамп сохранения с dump_version >= 5); "
              "размеры выведены из collision_box")
    if factory_mismatches:
        print("  расхождения среди заводских (тип, имя, из collision_box, из selection_box):")
        for row in factory_mismatches[:10]:
            print("   ", row)

    for probe in (("assembling-machine", "assembling-machine-1"), ("inserter", "inserter"),
                  ("inserter", "long-handed-inserter"), ("pipe-to-ground", "pipe-to-ground"),
                  ("loader-1x1", "mdrn-loader"), ("transport-belt", "transport-belt"),
                  ("electric-pole", "medium-electric-pole"), ("splitter", "splitter")):
        rec = entities.get(probe[0], {}).get(probe[1])
        if rec:
            print(f"  {probe[0]}/{probe[1]}: {json.dumps(rec, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
