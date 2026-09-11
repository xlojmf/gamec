import { RESOURCE_LABELS, type Resource } from '../game/terrain'

export function ResourceIcon({ resource }: { resource: Resource }) {
  return <img className="resource-icon" src={`/assets/astra/ui/${resource}.svg`} alt={RESOURCE_LABELS[resource]} title={RESOURCE_LABELS[resource]} />
}
