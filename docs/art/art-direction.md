# The Island — art and interaction guide

Warm, hand-painted terrain sits in a walnut tray on an ink-teal table. The playable 3D board uses the generated materials; the larger concept illustration is the landing hero, not a screenshot of gameplay.

## Palette and typography

| Role | Token |
|---|---|
| Deep teal table | `#102f35` |
| Lit table | `#173c42` |
| Ivory HUD | `#f7efda` |
| Body ink | `#2b413a` |
| Brass accent | `#e5bd74` |
| Primary action | `#315b49` |
| Display type | Palatino Linotype → Palatino → Georgia → serif |
| Body type | Trebuchet MS → Segoe UI → sans-serif |

Fonts use installed system families with explicit fallbacks, with no external font network dependency. Display type is reserved for titles; compact controls use the body family.

## Files and live reference

- `public/assets/astra/kit.html`: standalone visual asset catalog and UI reference.
- `public/assets/astra/concept/island.png`: generated concept / landing hero.
- `public/assets/astra/world/`: six terrain tops, six distinct terrain sides, water, walnut frame and ivory plate.
- `public/assets/astra/ui/`: custom five-resource SVG icon family, crest and six exact dice faces.
- `public/assets/astra/manifest.json`: world slots, UI paths and font pairing.
- `docs/art/prompts.md`: generation prompts.

## Renderer contract

Three.js stays inside `src/three/*`. GameView is the React-facing facade; scenery.ts and pieces.ts provide reusable model geometry and materials. GameView loads the manifest in the browser, maps CylinderGeometry material groups to side/top/bottom, loads color maps in sRGB, and shares textures/materials for the app lifetime. A failed material request keeps its procedural color. The ocean and frame live in one reattached group when reseeding. Live token numbers and probability pips are drawn separately from the generated ivory plate, preserving exact values and red 6/8s.

The 3D dice use exact canvas pip textures, with opposite faces summing to seven; the HUD uses the six SVG faces. Terrain props leave the number plate clear. Scene framing adjusts field of view on narrow screens; the HUD uses a desktop table grid and normal scrolling page flow on mobile. Motion respects the reduced-motion preference for the camera, water and placement drops. Dice still communicate the authoritative roll.

The September 11 miniature revision replaces isolated boulders with continuous triangulated slate ridges, coarse foliage with irregular fir branch whorls, and cone-shaped crops with dense planted wheat sheaves, paired kernels and awns. Buildings are painted carved-wood gables; cities have two wings and a taller central tower. `details/` contains three native imagegen textures derived from the concept's material language: slate, fir needles and light hardwood. Mountains reserve a flat central token clearing; trees and stalks respect the plate and hex boundary. Repeated vegetation shares geometry and is instanced by GameView. Unique mountain geometry is disposed on board rebuild.

## UI kit

Ivory control panels use dark ink and restrained green selected states. Primary actions use green on the HUD and brass on the landing screen. Keyboard focus has a visible brass outline. SVG icons have resource-name alternatives. Journal and reference sections are collapsible. The rules page has direct section links. The landing page provides local player count, local play, online play and the rules without engineering roadmap content.

## Feedback and negotiation

Sound uses selected existing MP3s under public/sounds for rolling, building, trading, robber movement, played cards and victory. Sound is on by default, with autoplay retried on the first interaction when required by the browser; a new cue replaces the previous clip. A transport below Around the table includes play, stop, volume and quick cues. Original sound files are unchanged.

New paid placements drop gently into position. The most recent paid road, settlement or city can be undone on the same turn until another logged action occurs. The exact cost and prior award ownership are restored. Setup has a separate change-corner action before committing the road. Free-road placement can be finished before or after rolling. The voyage journal retains the full match history.

Domestic trades can target one player or anyone at the table. Only recipients who can fulfill the proposed terms are offered the trade. First acceptance completes it once; individual declines leave the other recipients active. A counter replaces the offer with a one-to-one proposal to the original proposer. Every counter requires fresh acceptance and keeps the turn's active player involved. Hidden hands stay hidden.
