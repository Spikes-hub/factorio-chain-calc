# Dumps

[Русский](dumps.ru.md)

A *dump* is a JSON file with the recipes, items, machines and (optionally) the research state of your game.
The calculator is useless without one. Both scripts find Factorio themselves (Steam, any drive; if they can't,
they ask for the path once and remember it; or set the `FACTORIO_DIR` environment variable). They install a small
exporter mod only for the time of the dump and remove it afterwards. **Close Factorio before running them.**

## Full dump — `dump_full.bat`

Every recipe of your mod set plus building geometry (needed for generated blueprints). It does **not** know what
you have researched, so:

- "only researched recipes" is unavailable;
- all inserters and loaders start **unticked** in the *Inserters* tab (nothing is known to be researched) — tick the
  ones you have and enter their speed and stack size.

Fully automatic: the game window shows for about a minute and closes itself. Names come in the language of your game.

## Dump from a save — `dump_from_save.bat`

Pick a save from the list (Enter = the newest). The mod makes the dump when the save loads, the script closes the
game, pulls the icons and removes the mod. You get everything the full dump has, plus:

- what is **researched** (the page can hide the rest);
- the inserter **stack bonus** from your research;
- inserters and loaders are ticked by default **only if researched**.

## Repeating a dump

Run a dump again whenever your research or mods change. Your settings in the *Inserters* tab are kept; if some of
the inserters you set by hand now differ from the new dump, the tab offers to **update them to the dump** (or keep yours).

Icons and building geometry depend only on the game build and the mod set, so they are reused while the mod set is the
same (a repeated run is about three times faster). Add `--rebuild-icons` to the command inside the `.bat` to force it.

## Where things go

`data\datasets\<date>-full.json` / `<date>-save.json`, icons in `public\icons\`, geometry in `data\geometry\`.
You can also upload a ready `.json` with the **Upload dump** button on the page.
