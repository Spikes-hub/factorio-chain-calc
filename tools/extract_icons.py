r"""
extract_icons.py — разовый локальный скрипт (запускать руками, не через сервер).

В Factorio 2.0 движок убрал .icon/.icon_size из runtime API прототипов, так
что мод больше не может получить даже путь к иконке. Правильный способ —
встроенная в саму игру команда:

    "C:\Program Files (x86)\Steam\steamapps\common\Factorio\bin\x64\factorio.exe" --dump-icon-sprites

Она запускает игру (откроется окно на секунду-две, это нормально — ей нужен
графический backend, чтобы отрендерить иконки), сама разрешает все слои,
тонировку и модовые пути, и складывает готовые PNG в:

    %APPDATA%\Factorio\script-output\item\<name>.png
    %APPDATA%\Factorio\script-output\fluid\<name>.png
    %APPDATA%\Factorio\script-output\recipe\<name>.png
    %APPDATA%\Factorio\script-output\entity\<name>.png

Этот скрипт берёт готовые PNG оттуда, копирует нужные (только то, что
встречается в твоём chain-calc-dump.json) в public/icons/<type>/<name>.png и
пишет новый файл дампа с добавленным полем icon_url — его и нужно грузить в
приложение вместо исходного дампа.

Использование:
    python tools/extract_icons.py ^
        --dump chain-calc-dump.json ^
        --icon-sprites "%APPDATA%\Factorio\script-output" ^
        --out-dump dump-with-icons.json
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

# how our dataset's top-level tables map to --dump-icon-sprites' subfolders
TABLE_TO_SPRITE_FOLDER = {
    "items": "item",
    "fluids": "fluid",
    "recipes": "recipe",
    "entities": "entity",
}

# Если PNG нет в «своей» папке — где ещё поискать. Предмет и сущность, которую он
# ставит, обычно называются одинаково ("transport-belt"), а рецепт почти всегда
# зовётся как его главный продукт, так что промах в одной папке часто лечится
# соседней.
FALLBACK_FOLDERS = {
    "entity": ("item",),
    "item": ("entity",),
    "recipe": ("item", "fluid"),
}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dump", required=True, help="Путь к chain-calc-dump.json")
    ap.add_argument(
        "--icon-sprites",
        required=True,
        help=r"Папка, куда Factorio положил иконки после --dump-icon-sprites (обычно %%APPDATA%%\Factorio\script-output)",
    )
    ap.add_argument("--out-icons", default=None, help="Куда копировать PNG (по умолчанию <проект>/public/icons)")
    ap.add_argument("--out-dump", required=True, help="Куда записать дамп с добавленным icon_url")
    args = ap.parse_args()

    dump_path = Path(args.dump)
    sprites_dir = Path(args.icon_sprites)
    out_icons = Path(args.out_icons) if args.out_icons else Path(__file__).resolve().parent.parent / "public" / "icons"

    if not sprites_dir.exists():
        print(f"[!] Папка со спрайтами не найдена: {sprites_dir}")
        print("    Сначала запусти: factorio.exe --dump-icon-sprites")
        return

    print("Читаю дамп...")
    data = json.loads(dump_path.read_text(encoding="utf-8"))

    dump_version = data.get("dump_version", 1)
    print(f"Версия дампа: v{dump_version}")
    if dump_version < 2:
        print("    (v1 — старый экспортёр: без типов модулей, base_effect, drain и лент.")
        print("     Иконки всё равно вытащатся, но обнови export-mod/control.lua.)")

    total = 0
    resolved = 0
    fallbacks = 0
    missing_sample: list[str] = []
    per_table: dict[str, tuple[int, int]] = {}

    for table_name, sprite_folder in TABLE_TO_SPRITE_FOLDER.items():
        table = data.get(table_name, {})
        if not isinstance(table, dict):
            continue
        dst_dir = out_icons / sprite_folder
        dst_dir.mkdir(parents=True, exist_ok=True)

        table_total = 0
        table_resolved = 0
        for name, entry in table.items():
            if not isinstance(entry, dict):
                continue
            total += 1
            table_total += 1

            # Обычный путь: PNG лежит в папке своего типа. Но у --dump-icon-sprites
            # бывает так, что для сущности картинки нет, а для одноимённого предмета
            # (которым её ставят) — есть, и наоборот. Тогда берём, что нашлось:
            # лучше «не та папка», чем пустое место в интерфейсе.
            candidates = [(sprite_folder, sprites_dir / sprite_folder / f"{name}.png")]
            for alt in FALLBACK_FOLDERS.get(sprite_folder, ()):
                candidates.append((alt, sprites_dir / alt / f"{name}.png"))

            picked = next(((folder, path) for folder, path in candidates if path.exists()), None)
            if picked is None:
                if len(missing_sample) < 15:
                    missing_sample.append(f"{sprite_folder}/{name}")
                continue

            folder, src_file = picked
            if folder != sprite_folder:
                fallbacks += 1
            dst_dir_actual = out_icons / folder
            dst_dir_actual.mkdir(parents=True, exist_ok=True)
            dst_file = dst_dir_actual / f"{name}.png"
            if not dst_file.exists():
                shutil.copyfile(src_file, dst_file)
            entry["icon_url"] = f"/icons/{folder}/{name}.png"
            resolved += 1
            table_resolved += 1

        per_table[table_name] = (table_resolved, table_total)

    out_dump_path = Path(args.out_dump)
    out_dump_path.parent.mkdir(parents=True, exist_ok=True)
    out_dump_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    print()
    print(f"Готово: {resolved}/{total} иконок скопировано в {out_icons}")
    for table_name, (done, count) in per_table.items():
        print(f"    {table_name:<10} {done}/{count}")
    if fallbacks:
        print(f"    (из них {fallbacks} взяты из соседней папки — PNG в своей не нашлось)")

    # v2 кладёт ленты/манипуляторы/маяки в entities: если у лент нет иконок,
    # кнопки выбора ленты будут без картинок — не ошибка, но лучше знать.
    # v3 добавляет туда же погрузчики (loader-1x1/loader) — с ними в калькуляторе
    # появляется выбор «погрузчик» с настоящей скоростью и иконкой вместо
    # приблизительной «скорость как у ленты этого тира».
    belts = [e for e in (data.get("entities") or {}).values()
             if isinstance(e, dict) and e.get("type") == "transport-belt"]
    if belts:
        with_icons = sum(1 for b in belts if b.get("icon_url"))
        print(f"    лент в дампе: {len(belts)}, из них с иконками: {with_icons}")
    loaders = [e for e in (data.get("entities") or {}).values()
               if isinstance(e, dict) and e.get("type") in ("loader-1x1", "loader")]
    if loaders:
        with_icons = sum(1 for b in loaders if b.get("icon_url"))
        print(f"    погрузчиков в дампе: {len(loaders)}, из них с иконками: {with_icons}")

    print()
    print(f"Новый дамп записан в {out_dump_path} — загрузи именно его в приложение.")
    if missing_sample:
        print()
        print("Примеры того, для чего не нашлось PNG (не страшно, просто будет текст без иконки):")
        for m in missing_sample:
            print(f"  {m}")


if __name__ == "__main__":
    main()
