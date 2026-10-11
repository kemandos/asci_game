# Bloodborne ASCII

A fan-made, real-time ASCII action roguelike in the spirit of *Bloodborne*, running entirely in the browser — no build step, no dependencies.

Wake in a clinic on the night of the hunt, carve your way through procedurally generated streets of **Central Yharnam**, the **Tomb of Oedon** and the **Cathedral Ward**, and face the Cleric Beast, Father Gascoigne and Vicar Amelia. Between hunts, rest in the **Hunter's Dream**, where the Doll turns Blood Echoes into strength. And when the night is nearly over, Gehrman will offer to end the dream...

## Play

- Open `index.html` directly in a modern browser (it works from `file://`), **or**
- serve the folder with any static server, e.g. `python3 -m http.server` and visit <http://localhost:8000>, **or**
- publish it with GitHub Pages (Settings → Pages → deploy from branch root).

Progress is saved to `localStorage` whenever you rest at a lamp.

## Controls

| Action | Keyboard | Controller (Xbox / PlayStation) |
|---|---|---|
| Move (8 directions) | WASD · Arrow keys · Numpad | Left stick · D-pad |
| Light attack | J · Z | RB / R1 |
| Heavy attack | K · X | RT / R2 |
| Fire gun (parry) | L · C | LT / L2 |
| Quickstep dodge | Space · Shift | B / Circle |
| Transform trick weapon | Q · V | LB / L1 |
| Use Blood Vial | R | X / Square |
| Interact (lamps, Doll, notes…) | E · Enter | A / Cross |
| Blood Bullets (spend HP for bullets) | B | Y / Triangle |
| Music Box | M | Back / Select |
| Pause menu | Esc | Start / Options |
| Help · Toggle sound | H · N | — |
| Isometric / top-down view | T | — |

Menus: ↑/↓ (or stick/D-pad) to choose, Enter/Space/E (or A/Cross) to select, Esc (or B/Circle) to go back. Mouse works too.

## The ways of the hunt

- **Read the red.** Every enemy attack is telegraphed: the tiles it will strike glow red and grow brighter until the blow lands. Step out, or quickstep *through* it — dodging grants a moment of invulnerability.
- **Parry with your gun.** Shoot a foe late in its wind-up, while it flashes white-hot, to stagger it (it then pulses yellow). Then hit it with a light attack from an adjacent tile for a devastating **visceral attack**.
- **Rally.** Damage you take leaves an orange segment on your health bar. Hit enemies quickly to win it back. Aggression is survival.
- **Trick weapons** have two forms with different reach and shapes; the faint shade in front of you shows your current attack's reach.
- **Blood Echoes** are both currency and experience. Die and you drop them as a bloodstain `§`; reach it to reclaim them. Die again first, and they are lost.
- **Lamps** `¥` are checkpoints and your way back to the Hunter's Dream: level up with the Doll, buy from the Bath Messengers, upgrade your weapon with Blood Stone Shards `◊` at the workbench, and travel between lit lamps via the headstones.
- Bosses wait behind fog gates. Some can be interrupted, some can be distracted… read every message you find `?`.

## Legend

`@` you · `h r d v p B S T G` enemies · `!` Blood Vial · `:` Quicksilver Bullets · `◊` Blood Stone Shard · `°` Coldblood Dew · `∞` Umbilical Cord · `?` message · `¥` lamp · `§` your bloodstain · `░▒` fog gate

## Files

`js/util.js` helpers · `js/data.js` content · `js/map.js` level generation, lighting & FOV · `js/audio.js` synthesized sound · `js/game.js` game logic · `js/render.js` canvas renderer · `js/iso.js` isometric view · `js/ui.js` menus · `js/input.js` gamepad · `js/main.js` loop & keyboard.

## Disclaimer

This is an unofficial, non-commercial fan tribute. It is not affiliated with, endorsed by, or connected to FromSoftware, Sony Interactive Entertainment, or any rights holder of *Bloodborne*. All names referenced belong to their respective owners. All code, text, and sound here are original.
