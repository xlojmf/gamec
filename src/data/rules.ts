export interface RuleSection {
  id: string
  title: string
  paragraphs?: string[]
  bullets?: string[]
  table?: { headers: string[]; rows: string[][] }
}

/** Full base-game rules reference (also the implementation contract for M6–M11). */
export const RULES: RuleSection[] = [
  {
    id: 'components',
    title: '1 · Components',
    paragraphs: [
      'The island of Catan is built from 19 terrain hexes — 4 Forest, 4 Pasture, 4 Fields, 3 Hills, 3 Mountains and 1 Desert — surrounded by an ocean frame holding 9 ports: four generic 3:1 harbors and one special 2:1 harbor for each resource.',
      '18 number tokens (2–12, no 7) mark producing hexes. Each player commands a supply of 15 roads, 5 settlements and 4 cities. The bank holds 19 cards of each of the five resources, and the development deck contains 14 Knights, 2 Road Building, 2 Year of Plenty, 2 Monopoly and 5 Victory Point cards.',
    ],
  },
  {
    id: 'setup',
    title: '2 · Setup',
    bullets: [
      'Shuffle the terrain hexes and assemble the island (a center hex, a ring of 6 and a ring of 12).',
      'Place number tokens face-up in a clockwise spiral, starting from an outer hex and ending at the center.',
      'Place the robber on the desert.',
      'Determine a starting player at random. In snake order (P1→P4, then P4→P1) each player places a settlement plus one connecting road.',
      'Each player collects 1 resource card of each type produced by the hexes adjacent to their second settlement.',
    ],
  },
  {
    id: 'turn',
    title: '3 · Turn Structure',
    paragraphs: [
      'A turn flows Roll → (produce, or robber on a 7) → Trade → Build. Play then passes clockwise.',
    ],
    bullets: [
      'Roll two dice. Every hex whose number token matches the sum produces resources: 1 card per adjacent settlement, 2 per adjacent city.',
      'A hex blocked by the robber produces nothing. If the bank’s stack of a resource is empty, players who would draw it get nothing.',
      'Rolling a 7 produces nothing instead: every player holding more than 7 cards discards half (rounded down); the active player moves the robber to any hex and steals 1 random card from a player with a building adjacent to it.',
      'Trading and building may happen in any order and quantity, as long as you can pay.',
    ],
  },
  {
    id: 'trading',
    title: '4 · Trading',
    bullets: [
      'Domestic trade: on your turn, strike any deal with another player. Only the active player’s trades are legal, and you may never trade identical resources (no wood for wood).',
      'Maritime trade: trade 4 identical cards with the bank for 1 of any resource.',
      'Generic port (3:1): if you have a settlement or city on one of a generic port’s two corners, bank trades cost only 3.',
      'Special port (2:1): a port marked with a resource trades 2 of that resource for 1 of any.',
    ],
  },
  {
    id: 'building',
    title: '5 · Building',
    paragraphs: [
      'You may build as much as your resources and piece supply allow. Roads connect your network; settlements and cities occupy intersections.',
    ],
    table: {
      headers: ['Piece', 'Lumber', 'Brick', 'Wool', 'Grain', 'Ore', 'Limits & rules'],
      rows: [
        ['Road', '1', '1', '', '', '', '15 max · empty edge connected to your road network or a building'],
        ['Settlement', '1', '1', '1', '1', '', '5 max · empty vertex, connected, distance rule: ≥2 edges from any building'],
        ['City', '', '', '', '2', '3', '4 max · upgrades one of your settlements'],
        ['Dev card', '', '', '1', '1', '1', '25-card deck'],
      ],
    },
    bullets: [
      'The distance rule: a settlement may never be placed directly adjacent (1 edge away) to any other settlement or city.',
      'An opponent’s settlement on a junction breaks the continuity of your road path (this matters for Longest Road).',
    ],
  },
  {
    id: 'devcards',
    title: '6 · Development Cards',
    bullets: [
      'You may play at most 1 development card per turn — never one you bought this turn. Victory Point cards are the only exception: they may be revealed immediately if they win you the game.',
      'Knight (×14) — move the robber and steal 1 card, exactly as after rolling a 7. Played knights count toward Largest Army.',
      'Road Building (×2) — immediately place up to 2 free roads (standard placement rules).',
      'Year of Plenty (×2) — take any 2 resources from the bank (they may match).',
      'Monopoly (×2) — name a resource; every other player hands over all their cards of that type.',
      'Victory Point (×5) — worth 1 VP, kept hidden until played.',
    ],
  },
  {
    id: 'awards',
    title: '7 · Special Awards',
    bullets: [
      'Longest Road — a continuous road of 5+ segments. Worth 2 VP; only one player can hold it, and it is stolen by building a longer road.',
      'Largest Army — 3+ played knights. Worth 2 VP; likewise stolen when exceeded.',
    ],
  },
  {
    id: 'winning',
    title: '8 · Winning the Game',
    paragraphs: [
      'The first player to reach 10 victory points on their own turn wins immediately. VP come from: 1 per settlement, 2 per city, 2 for Longest Road, 2 for Largest Army and 1 per Victory Point development card.',
    ],
  },
]
