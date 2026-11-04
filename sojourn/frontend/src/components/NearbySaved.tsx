// "Saved places nearby": want-to-visit places within ~30 km of this trip's
// stops, closest first. Renders nothing when there are none, so a trip
// without saved places looks exactly as before.

import { useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useNearbySaved } from '../api/hooks'
import type { SavedPlace, Trip } from '../api/types'
import { categoryColor, label } from '../utils'
import AddToTripDialog from './AddToTripDialog'
import { Icon } from './ui'

const SHOW = 4

const distance = (km: number) => (km < 1 ? `${Math.round(km * 1000 / 50) * 50 || 50} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`)

export default function NearbySaved({ trip }: { trip: Trip }) {
  const { data: places = [] } = useNearbySaved(trip.id)
  const [all, setAll] = useState(false)
  const [adding, setAdding] = useState<SavedPlace | null>(null)

  if (places.length === 0) return null
  const shown = all ? places : places.slice(0, SHOW)

  return (
    <section className="nearby" aria-labelledby="nearby-title">
      <div className="nearby-head">
        <h2 className="section-title" id="nearby-title">
          <Icon name="bookmark" size={15} /> Saved places nearby
          <span className="count">{places.length}</span>
        </h2>
        <Link to="/saved?status=want" className="btn-text">
          All saved places
        </Link>
      </div>
      <ul className="nearby-list">
        {shown.map((p) => (
          <li key={p.id} className="nearby-row">
            <span className="nearby-dot" style={{ '--c': categoryColor(p.category) } as CSSProperties} aria-hidden="true" />
            <div className="nearby-main">
              <p className="nearby-name">{p.name}</p>
              <p className="nearby-meta">
                <span className="cat" style={{ '--c': categoryColor(p.category) } as CSSProperties}>
                  {label(p.category)}
                </span>
                <span>
                  {distance(p.distance_km)} from {p.near_stop}
                </span>
                {p.tags.slice(0, 2).map((t) => (
                  <span key={t} className="tag is-static">
                    {t}
                  </span>
                ))}
              </p>
            </div>
            <button type="button" className="btn nearby-add" onClick={() => setAdding(p)} aria-label={`Add ${p.name} to this trip`}>
              <Icon name="plus" size={14} /> Add
            </button>
          </li>
        ))}
      </ul>
      {places.length > SHOW && (
        <button type="button" className="btn-text" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${places.length}`}
        </button>
      )}
      <AddToTripDialog place={adding} trip={trip} onClose={() => setAdding(null)} />
    </section>
  )
}
