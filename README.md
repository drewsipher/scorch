# SCORCH — Scorched Earth Reborn

A modern browser remake of the 1991 DOS classic *Scorched Earth*: turn-based tank
artillery on fully destructible procedural terrain, with the complete economy /
armory / upgrade loop, AI personalities, and local or online multiplayer.

![genre](https://img.shields.io/badge/genre-artillery-orange) ![deps](https://img.shields.io/badge/runtime%20deps-1%20(ws)-green)

## Play

```bash
npm install
npm start          # → http://localhost:8080
```

- **Campaign** — 10 escalating solo missions. Cash and ammo persist between
  missions; you visit the armory before every deployment. Early foes lob baby
  missiles; by the finale they're carrying MIRVs, Death's Heads and nukes.
  Progress auto-saves.
- **Local Battle** — up to 8 players, any mix of humans (hotseat) and AI.
  Everyone (AIs included) stocks up in the armory before round 1.
- **Sandbox Editor** — paint your own battlefield (draw/erase brushes, floating
  islands, canyons, any of the six worlds), place your spawn and up to seven
  enemies, choose each enemy's AI and hand-pick its exact arsenal, then name,
  save, and play your maps. Post-battle you can replay or jump straight back
  into the editor.
- **Host Online Game** — share the 4-letter room code; friends join from their
  browser at your address. Late peers are auto-assigned tanks. If someone
  disconnects, an AI takes over their tank.

## Controls

| Input | Action |
|---|---|
| `← →` | aim barrel (hold `Shift` for fine) |
| `↑ ↓` / mouse wheel | power |
| `Tab` / `[` `]` | cycle weapons |
| `Q` or ▤ button | pull-up weapon rack (icon grid of everything you own) |
| `A` / `D` | move tank (consumes fuel) |
| `B` | use battery (+30 HP) |
| `Space` / `Enter` | **FIRE** |
| mouse drag on canvas | slingshot aiming |

## The game

- **17 weapons**: Baby Missile → Nuke, MIRV, Death's Head, rollers that hunt
  downhill, diggers that tunnel, napalm that flows and burns, dirt bombs that
  bury, leapfrogs, funky bombs, homing missiles…
- **Economy**: earn cash for damage, kills, and survival; 5% interest between
  rounds; spend it in the armory on firepower, shields, parachutes, batteries
  and fuel.
- **AI personalities**: Moron, Shooter, Poolshark, Cyborg, Unknown. Everyone
  hunts a firing solution and walks shots in turn by turn — but each has an
  accuracy floor, so even Unknown never snipes you automatically, and morons
  stay comedy relief (random targets, wild lobs, occasionally backwards).
- **Living battlefield**: wind that drifts every turn, tanks that fall (pack a
  parachute) — and **Noita-style falling-sand terrain**: blasts loosen the rock
  into granular sand that pours, slides, and piles at its angle of repose.
- **Seven ways to die**, Scorched Earth style: every kill triggers an
  anime-style buildup (shaking, flickering, a rising whine)… then a dud
  *pfffrt*, a pop, a boom, a cascading chain, an ammo cook-off that fires
  random shells, a napalm spray, or a full nuke. Chain reactions welcome.
- **Explosion light shows**: every blast flashes its exact area-of-effect
  circle; nukes add light pillars and double shockwaves, funky bombs strobe
  in five colors, dirt weapons throw dust instead of fire.
- **Fully customizable battles**: rounds (1–∞ endless), starting cash,
  interest, wind strength & drift, gravity (moon/heavy), ammo packages up to
  infinite everything, armory on/off, fall damage, armor, AI skill, and world
  selection — all saved between sessions and synced in online games.
- **Six worlds**: Ember Dusk, Void Night, Toxic Dawn, Rust Storm, Glacier
  (snowfall), Violet Sea (synthwave grid-sun) — procedural strata terrain with
  neon surface glow, parallax ranges, and full dynamic FX.
- **Metal Slug-style pixel art**, all generated in code at load time: animated
  tank sprites (rolling treads, recoil, exhaust puffs, slope tilt), 22 unique
  weapon/item icons that also fly as projectiles, chunky clouds, dithered
  terrain with an outlined crust, an animated windsock, and wind streaks that
  pick up as the wind does.
- **All audio synthesized live** with Web Audio — zero asset files. Upbeat
  chiptune march (drums, walking bass, swing lead) plus full SFX.

## Architecture

```
public/js/
  config.js    weapons, items, AI defs, themes, economy constants
  utils.js     seeded RNG, 1D value noise, color helpers
  terrain.js   bitmap terrain (tunnels/overhangs), carve/dirt/compact, strata art
  sim.js       deterministic fixed-step match engine (headless-capable)
  ai.js        trajectory solver, personalities, learning, shopping
  sprites.js   pixel-art factory: tank sprites, 22 weapon/item icons, clouds
  renderer.js  canvas painter: sky/parallax/tanks/FX/camera — reads sim, never writes
  sound.js     Web Audio synthesis
  ui.js        DOM screens: menu, setup, armory, summaries + HUD
  net.js       WebSocket room client
  main.js      orchestration: loop, input, turn flow, netplay lockstep
server.js      static hosting + dumb WebSocket relay (rooms)
```

Online play is **lockstep**: the sim is fully deterministic (seeded RNG,
fixed timestep, integer terrain ops), so only player actions cross the wire;
every client runs the identical simulation. A watchdog keeps backgrounded tabs
stepping so they never fall behind.

## Tests

```bash
npm test               # headless engine tests (terrain, weapons, economy,
                       #   determinism, 10 full AI-vs-AI matches)
node test/smoke.js     # browser boot + play smoke test (needs Chrome)
node test/flow.js      # full loop: round → summary → shop → next round → game over
node test/netplay.js   # two-browser lockstep sync verification
node test/themes.js    # screenshot gallery of all six themes
node test/action.js    # screenshot gallery of weapon FX
node test/deaths.js    # death sequences, sand physics, options UI
node test/campaign.js  # campaign flow, saves, foe arsenal escalation
node test/sandbox.js   # map editor, terrain painting, custom spawns/loadouts
node test/ui-check.js  # weapon rack, shop icons, music engine
```

Browser tests expect the server running (`npm start`) and Chrome at
`/usr/bin/google-chrome` (uses `puppeteer-core`).
