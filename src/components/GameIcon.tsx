import type { DevCardType } from '../game/catan'

type IconName = 'road' | 'settlement' | 'city' | 'cards' | 'knight' | 'roadBuilding' | 'yearOfPlenty' | 'monopoly' | 'victoryPoint' | 'compass'

/** A consistent engraved icon set for the tabletop controls. */
export function GameIcon({ name, className = '' }: { name: IconName; className?: string }) {
  const shapes: Record<IconName, React.ReactNode> = {
    road: <><path d="m5 22 5-20m9 20L14 2M12 5v3m0 4v3m0 4v2" /></>,
    settlement: <><path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7" /></>,
    city: <><path d="M3 21V10h8v11m0 0V3h8v18M1 21h22M14 7h2m-2 4h2m-2 4h2M6 14h2m-2 4h2" /></>,
    cards: <><path d="M8 4h12v17H8zM5 18H3V2h12" /><path d="m14 8 3 4-3 4-3-4z" /></>,
    knight: <><path d="m5 3 12 14m-9-4-5 5m1-7 9 10M19 3 7 17m9-4 5 5m-1-7-9 10M4 3l4 1-3 3zm16 0-4 1 3 3z" /></>,
    roadBuilding: <><path d="M2 18h5l4-12h5l6 12M3 14h5m2-4h7m-5 4h7M2 21h20" /></>,
    yearOfPlenty: <><path d="M5 11h14l-2 10H7zM8 11 6 4m5 7 1-9m3 9 3-8M4 4l4 3m2-2 4-1m2 3 4-1" /></>,
    monopoly: <><path d="m3 7 4 4 5-7 5 7 4-4-2 12H5zM5 22h14" /></>,
    victoryPoint: <><path d="m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z" /></>,
    compass: <><circle cx="12" cy="12" r="9" /><path d="m16 6-2 8-8 4 4-8zM12 1v3m0 16v3M1 12h3m16 0h3" /></>,
  }
  return <svg className={`game-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{shapes[name]}</svg>
}

/**
 * The painted knight portrait (`/assets/astra/ui/knight.png`, golden figure on
 * transparency) — used wherever a knight is shown larger than a tiny glyph
 * (card announcements, dev-card chips) so knights get real art, not just the
 * engraved sword icon. Sized per context via CSS (`.knight-art`).
 */
export function KnightArt({ className = '' }: { className?: string }) {
  return (
    <img
      className={`knight-art ${className}`}
      src="/assets/astra/ui/knight.png"
      alt="Knight"
      draggable={false}
    />
  )
}

/** Per-card icon: real knight art for the Knight, engraved SVG for the rest. */
export function DevCardIcon({ card, className = '' }: { card: DevCardType; className?: string }) {
  return card === 'knight' ? <KnightArt className={className} /> : <GameIcon name={card} className={className} />
}
