# Changelog

**English** · [Русский](CHANGELOG.ru.md)

All notable changes are listed here, newest first. Format: version — date.

## Unreleased

- Train section: when the loading and unloading of one train are slower than the block eats, the number of trains is calculated (each train loads at its own station) and the amount per trip is shown for one train.

## 0.2.0 — 2026-10-10

### Major changes

- **Pipes in blueprints.** The block generator now lays pipes and underground pipes for fluid inputs and outputs,
  supports machines with fluid fuel, and builds the layouts learned from hand-built templates (casting with a loader,
  acetylene, bitumen, creosote, glassworks, distillator, heat exchanger, fluidized bed reactor, mirrored pairs with a
  one-tile gap). A layout diagram is shown before you copy the string. A recipe whose machine has no layout sample yet
  is refused with a clear message instead of a guess: clear the *pipes* checkbox to get the block without pipes.
  Recipes the generator cannot build dropped from 215 to 67.
  **Make a new dump** after updating: the fuel input of fluid-fuel machines is read from the building geometry.
- **Mirrored machines and a stricter pipe check.** Machines can be placed mirrored (the `mirror` flag of Factorio 2.0),
  an underground pipe connects only by its mouth and to the nearest pair, as in the game, and a block whose pipes
  would mix two fluids of one machine is refused instead of produced. Machines with ports in the centre of all four
  walls get a one-tile gap between machines; a single pass-through fluid input (soil extractor) is fed to the top
  machine of a column only.
- **Train ETA mod support.** Tick "I use the mod" in the settings (name, GitHub and mod portal links are there) and a
  *Train* section appears above the beacons: enter the travel time (min:sec, one way, the round trip is counted as x2)
  for each resource of the tab and get how much to carry per trip so that the block does not stand idle, with a +30%
  reserve. Loading and unloading speeds are set in the settings (60 and 60 by default), fluids are loaded instantly
  and counted in litres, fuel is counted separately.
- **Recipe groups.** A byproduct that a tab further down the chain returns (for example the rejects of a hydrocyclone
  that eats the group's item) goes entirely to the group member that recycles it, rounded up to whole machines; the
  other members cover the rest. Stages with no solid inputs are cut into groups by the output belt, and next to
  "machines in a group" there is a new "groups" field (the two fields clear each other).

### Minor changes

- Fixed minor bugs and polished the interface.

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
