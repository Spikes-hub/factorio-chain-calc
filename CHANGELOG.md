# Changelog

**English** · [Русский](CHANGELOG.ru.md)

All notable changes are listed here, newest first. Format: version — date.

## Unreleased

- Documented the game version the dump was checked with: Factorio 2.0.77 (Pyanodon set, mod versions in the README).

## 0.1.0 — 2026-10-06

First public release.

- Production chain calculator: machines, modules, beacons, productivity, loops, fuel and ash of burner machines.
- Belts, fluids, inserters and loaders; the *Inserters* tab with tick boxes (researched ones by default in a save dump,
  none in a full dump), kept between dumps, with an offer to update hand-edited rows to a new dump.
- Blueprint generation for the layout of a block.
- Request chest for the whole chain; request chest for any pasted blueprint; "Assemble everything" mall.
- Recipe search by name, product, ingredient or id.
- Dumps: `dump_full.bat` (all recipes + geometry) and `dump_from_save.bat` (also what is researched); names in the
  language of your game; icons and geometry cached per mod set.
- English / Russian interface, dark theme, phone layout.
