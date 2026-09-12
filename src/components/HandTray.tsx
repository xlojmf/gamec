import { DEV_CARD_INFO, type DevCardEntry, type DevCardType } from '../game/catan'
import { RESOURCES, RESOURCE_LABELS, totalCards, type ResourceCounts } from '../game/terrain'
import { ResourceIcon } from './ResourceIcon'
import { GameIcon, DevCardIcon } from './GameIcon'

interface HandTrayProps {
  name: string
  hand: ResourceCounts
  cards: DevCardEntry[]
  turn: number
  canPlay: boolean
  onOpenCards: () => void
}

export function HandTray({ name, hand, cards, turn, canPlay, onOpenCards }: HandTrayProps) {
  const kinds = [...new Set(cards.map(entry => entry.card))]
  const status = (kind: DevCardType) => kind === 'victoryPoint' ? 'Counts toward victory'
    : cards.filter(entry => entry.card === kind).every(entry => entry.boughtTurn === turn) ? 'Ready next turn'
      : canPlay ? 'Ready to play' : 'View card'
  return <section className="hud resource-tray" aria-label="Your resource and development cards">
    <div className="tray-label"><span className="eyebrow">{name}’S HAND</span><span>{totalCards(hand)} resources · {cards.length} development</span></div>
    <div className="hand-card-row">
      <div className="resource-cards">{RESOURCES.map(resource => <div className={`resource-card ${hand[resource] === 0 ? 'resource-empty' : ''}`} key={resource}>
        <ResourceIcon resource={resource} /><strong>{hand[resource]}</strong><span>{RESOURCE_LABELS[resource]}</span>
      </div>)}</div>
      <div className="development-cards" aria-label="Your development cards">
        {kinds.length ? kinds.map(kind => <button className="development-card" key={kind} onClick={onOpenCards} title={`${DEV_CARD_INFO[kind].label}: ${DEV_CARD_INFO[kind].hint}. ${status(kind)}`}>
          <DevCardIcon card={kind} /><strong>{DEV_CARD_INFO[kind].label}</strong>
          <span className="dev-count">×{cards.filter(entry => entry.card === kind).length}</span><small>{status(kind)}</small>
        </button>) : <div className="development-empty"><GameIcon name="cards" /><div><strong>Development cards</strong><span>Your cards will appear here</span></div></div>}
      </div>
    </div>
  </section>
}
