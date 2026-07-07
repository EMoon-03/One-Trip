// The map provider pattern, frontend edition.
//
//   TripMap            decides which provider renders, via /api/config
//   LeafletTripMap     OpenStreetMap tiles — free, no key, the default
//   GoogleTripMap      Google Maps JS — activates when a browser key is set
//
// Both draw the same thing: category-colored station dots (matching the
// itinerary's metro line) connected by a route polyline in visit order.
// Swapping vendors is configuration, not a rewrite — the same argument as a
// multi-provider LLM client.

import 'leaflet/dist/leaflet.css'
import { latLngBounds } from 'leaflet'
import { useEffect, useMemo } from 'react'
import { CircleMarker, MapContainer, Polyline, Popup, TileLayer } from 'react-leaflet'
import {
  AdvancedMarker,
  APIProvider,
  Map as GMap,
  useMap,
} from '@vis.gl/react-google-maps'
import { useConfig, useItinerary } from '../api/hooks'
import type { ItineraryItem, Trip } from '../api/types'
import { categoryColor, formatDate, formatTime } from '../utils'

type Stop = ItineraryItem & { lat: number; lng: number }

const hasCoords = (item: ItineraryItem): item is Stop => item.lat !== null && item.lng !== null

// ---------------------------------------------------------------- leaflet --

function LeafletTripMap({ stops }: { stops: Stop[] }) {
  const bounds = useMemo(
    () => latLngBounds(stops.map((s) => [s.lat, s.lng] as [number, number])).pad(0.25),
    [stops],
  )

  return (
    <MapContainer bounds={bounds} scrollWheelZoom className="map-canvas">
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      />
      <Polyline
        positions={stops.map((s) => [s.lat, s.lng] as [number, number])}
        pathOptions={{ color: '#1c4fd8', weight: 2.5, opacity: 0.7, dashArray: '6 6' }}
      />
      {stops.map((stop) => (
        <CircleMarker
          key={stop.id}
          center={[stop.lat, stop.lng]}
          radius={9}
          pathOptions={{
            fillColor: categoryColor(stop.category),
            fillOpacity: 1,
            color: '#ffffff',
            weight: 2.5,
          }}
        >
          <Popup>
            <strong>{stop.title}</strong>
            <br />
            {formatDate(stop.date)}
            {stop.start_time ? ` · ${formatTime(stop.start_time)}` : ''}
            {stop.location_name ? ` · ${stop.location_name}` : ''}
          </Popup>
        </CircleMarker>
      ))}
    </MapContainer>
  )
}

// ----------------------------------------------------------------- google --

/** Fit the viewport to all stops once the map instance exists. */
function FitBounds({ stops }: { stops: Stop[] }) {
  const map = useMap()
  useEffect(() => {
    if (!map || stops.length === 0) return
    const bounds = new google.maps.LatLngBounds()
    stops.forEach((s) => bounds.extend({ lat: s.lat, lng: s.lng }))
    map.fitBounds(bounds, 48)
  }, [map, stops])
  return null
}

/** vis.gl has no <Polyline> component — draw one imperatively on the map. */
function RouteLine({ stops }: { stops: Stop[] }) {
  const map = useMap()
  useEffect(() => {
    if (!map || stops.length < 2) return
    const line = new google.maps.Polyline({
      path: stops.map((s) => ({ lat: s.lat, lng: s.lng })),
      strokeColor: '#1c4fd8',
      strokeOpacity: 0.7,
      strokeWeight: 2.5,
    })
    line.setMap(map)
    return () => line.setMap(null)
  }, [map, stops])
  return null
}

function GoogleTripMap({ stops, apiKey }: { stops: Stop[]; apiKey: string }) {
  const center = stops[0] ? { lat: stops[0].lat, lng: stops[0].lng } : { lat: 0, lng: 0 }
  return (
    <APIProvider apiKey={apiKey}>
      {/* DEMO_MAP_ID is Google's sandbox map style id; AdvancedMarker needs one. */}
      <GMap
        mapId="DEMO_MAP_ID"
        defaultCenter={center}
        defaultZoom={12}
        gestureHandling="greedy"
        className="map-canvas"
      >
        <FitBounds stops={stops} />
        <RouteLine stops={stops} />
        {stops.map((stop) => (
          <AdvancedMarker
            key={stop.id}
            position={{ lat: stop.lat, lng: stop.lng }}
            title={`${stop.title}${stop.location_name ? ` · ${stop.location_name}` : ''}`}
          >
            <span className="map-station" style={{ background: categoryColor(stop.category) }} />
          </AdvancedMarker>
        ))}
      </GMap>
    </APIProvider>
  )
}

// ------------------------------------------------------------------ shell --

export default function TripMap({ trip }: { trip: Trip }) {
  const { data: config } = useConfig()
  const { data: items = [], isLoading } = useItinerary(trip.id)

  const stops = items.filter(hasCoords)
  const googleKey = config?.google_maps_browser_key ?? null

  if (isLoading) return <p className="empty">Loading map…</p>

  if (stops.length === 0) {
    return (
      <div className="card empty-card">
        <h3>Nothing to map yet</h3>
        <p>
          Stops added with the location search carry coordinates and show up here as stations on
          the route.
        </p>
      </div>
    )
  }

  return (
    <div className="tab-body">
      <div className="map-meta mono">
        <span>
          {stops.length} of {items.length} stop{items.length === 1 ? '' : 's'} on the map
        </span>
        <span className="map-provider">{googleKey ? 'Google Maps' : 'OpenStreetMap · Leaflet'}</span>
      </div>
      <div className="card map-wrap">
        {googleKey ? <GoogleTripMap stops={stops} apiKey={googleKey} /> : <LeafletTripMap stops={stops} />}
      </div>
    </div>
  )
}
