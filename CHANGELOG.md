# Changelog

**English** · [Русский](CHANGELOG.ru.md)

All notable changes are listed here, newest first. Format: version — date.

## Unreleased

- Blueprints: the generator now lays pipes and underground pipes for fluid inputs and outputs, supports machines with fluid fuel (turned so the fuel port faces a pipe), several layouts learned from hand-built templates (casting with a loader, acetylene, bitumen, creosote, glassworks, distillator, mirrored pairs with a one-tile gap) and a preview of the layout. A recipe whose machine has no layout sample yet is refused with "no pipe layout sample" instead of a guess; clear the *pipes* checkbox to get the block without pipes. **Make a new dump** after updating: the fuel input of fluid-fuel machines is read from the geometry.
- Blueprints: machines can be placed mirrored (the `mirror` flag of Factorio 2.0), which lets both columns of a block have their ports on the same rows; the pipe check follows the game rules strictly (an underground pipe connects only by its mouth, to the nearest pair) and a block whose pipes would mix two fluids of one machine is refused instead of produced; the port order prefers the opposite wall before ports that look along the wall; machines with ports in the centre of all four walls (heat exchanger) get a one-tile gap between every two machines with the fluids passing through the gaps.
- Stages with no solid inputs (raw material only by pipes) are cut into groups by the output belt, and the manual "machines in a group" field is shown for them too.
- Machines whose only fluid input passes through (soil extractor: two opposite input-output mouths) are stacked in a column without gaps; the fluid is brought only to the top machine and passes through the rest.
- Recipe search and the "How to get" window show the machine a recipe is made in, right under the recipe name.
- `start.bat`: Ctrl+C stops the server without the "Terminate batch job (Y/N)?" question.
- Dropdowns (machines, fuel, beacons, stages, saved chains) show icons; ash from burnt fuel gets its own output belt.
- Documented the game version the dump was checked with: Factorio 2.0.77 (Pyanodon set, mod versions in the README).
- Recipe groups: a byproduct that a tab further down the chain returns (for example the rejects of a hydrocyclone that eats the group's item) now goes entirely to the group member that recycles it, rounded up to whole machines; the other members cover the rest. The loop is searched along the whole chain towards the head tab.
- Feed lines show the stage total next to the per-group rate when there are several feed groups.
- Recipes with the same name are told apart by their inputs ("— from: ...") in the recipe picker, tab hints and the group summary, instead of the internal id.

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
