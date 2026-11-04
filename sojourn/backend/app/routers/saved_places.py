"""Saved places and collections: places you want to go, with or without a trip.

    /api/saved-places                   list (filter by status, tag, collection, text) / save
    /api/saved-places/tags              your tags with counts
    /api/saved-places/{id}              edit / delete (stops made from it keep existing)
    /api/saved-places/{id}/add-to-trip  drop it onto a day of a trip as a stop
    /api/itinerary/{id}/save            the reverse: bookmark a stop
    /api/trips/{id}/saved-places/nearby want-to-visit places near this trip's stops
    /api/collections                    named groups ("Tokyo eats"); a place can be in many

Everything is scoped to the signed-in user; someone else's ids answer 404,
as everywhere else in the API.
"""

import math
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import or_
from sqlmodel import Session, func, select

from ..auth import get_current_user
from ..database import get_session
from ..geo import GeoError
from ..geo.refresh import stamp_coords
from ..geo.timezones import zone_for
from ..models import (
    AddToTrip,
    Collection,
    CollectionCreate,
    CollectionPlace,
    CollectionRead,
    CollectionUpdate,
    ItineraryItem,
    ItineraryItemRead,
    NearbySavedPlace,
    PlaceInTrip,
    PlaceStatus,
    SavedPlace,
    SavedPlaceCreate,
    SavedPlaceRead,
    SavedPlaceUpdate,
    TagCount,
    Trip,
    User,
)
from ..timeutil import utcnow
from .itinerary import get_owned_item
from .trips import get_owned_trip

router = APIRouter(prefix="/api", tags=["saved places"])

NEARBY_KM = 30.0
NEARBY_LIMIT = 12


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def get_owned_place(saved_id: int, user: User, session: Session) -> SavedPlace:
    place = session.get(SavedPlace, saved_id)
    if not place or place.user_id != user.id:
        raise HTTPException(status_code=404, detail=f"Saved place {saved_id} not found")
    return place


def get_owned_collection(collection_id: int, user: User, session: Session) -> Collection:
    coll = session.get(Collection, collection_id)
    if not coll or coll.user_id != user.id:
        raise HTTPException(status_code=404, detail=f"Collection {collection_id} not found")
    return coll


def _check_collections(ids: list[int], user: User, session: Session) -> list[int]:
    ids = list(dict.fromkeys(ids))  # dedupe, keep order
    for cid in ids:
        get_owned_collection(cid, user, session)
    return ids


def _set_collections(place: SavedPlace, ids: list[int], session: Session) -> None:
    current = {
        link.collection_id: link
        for link in session.exec(select(CollectionPlace).where(CollectionPlace.place_id == place.id))
    }
    for cid, link in current.items():
        if cid not in ids:
            session.delete(link)
    for cid in ids:
        if cid not in current:
            session.add(CollectionPlace(collection_id=cid, place_id=place.id))  # type: ignore[arg-type]


def _duplicate(user: User, google_or_osm_id: str | None, session: Session, exclude: int | None = None):
    if not google_or_osm_id:
        return None
    q = select(SavedPlace).where(SavedPlace.user_id == user.id, SavedPlace.place_id == google_or_osm_id)
    if exclude is not None:
        q = q.where(SavedPlace.id != exclude)
    return session.exec(q).first()


def _reads(places: list[SavedPlace], session: Session) -> list[SavedPlaceRead]:
    """Attach collection ids and trip appearances, in two queries total."""
    ids = [p.id for p in places]
    colls: dict[int, list[int]] = defaultdict(list)
    trips: dict[int, list[PlaceInTrip]] = defaultdict(list)
    if ids:
        for link in session.exec(
            select(CollectionPlace).where(CollectionPlace.place_id.in_(ids))  # type: ignore[attr-defined]
        ):
            colls[link.place_id].append(link.collection_id)
        rows = session.exec(
            select(ItineraryItem, Trip)
            .join(Trip, Trip.id == ItineraryItem.trip_id)  # type: ignore[arg-type]
            .where(ItineraryItem.saved_place_id.in_(ids))  # type: ignore[union-attr]
            .order_by(ItineraryItem.date)
        )
        for stop, trip in rows:
            trips[stop.saved_place_id].append(  # type: ignore[index]
                PlaceInTrip(
                    stop_id=stop.id,  # type: ignore[arg-type]
                    trip_id=trip.id,  # type: ignore[arg-type]
                    trip_name=trip.name,
                    trip_timezone=trip.timezone,
                    date=stop.date,
                )
            )
    return [
        SavedPlaceRead.model_validate(
            p, update={"collection_ids": sorted(colls[p.id]), "in_trips": trips[p.id]}  # type: ignore[index]
        )
        for p in places
    ]


def _read(place: SavedPlace, session: Session) -> SavedPlaceRead:
    return _reads([place], session)[0]


def _day(d) -> str:
    return f"{d:%b} {d.day}"


def km_between(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    """Great-circle distance (haversine), good to well under 1% at city scale."""
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


# ---------------------------------------------------------------------------
# saved places
# ---------------------------------------------------------------------------


@router.get("/saved-places", response_model=list[SavedPlaceRead])
def list_places(
    status: PlaceStatus | None = None,
    tag: str | None = None,
    collection_id: int | None = None,
    q: str | None = Query(default=None, max_length=100),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    query = select(SavedPlace).where(SavedPlace.user_id == user.id)
    if status:
        query = query.where(SavedPlace.status == status)
    if collection_id is not None:
        get_owned_collection(collection_id, user, session)
        query = query.join(CollectionPlace, CollectionPlace.place_id == SavedPlace.id).where(  # type: ignore[arg-type]
            CollectionPlace.collection_id == collection_id
        )
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.where(
            or_(
                func.lower(SavedPlace.name).like(like),
                func.lower(SavedPlace.address).like(like),
                func.lower(SavedPlace.notes).like(like),
            )
        )
    places = list(session.exec(query.order_by(SavedPlace.updated_at.desc())))  # type: ignore[attr-defined]
    if tag:
        # Tags are a small JSON list per place; filtering here keeps the query
        # identical on SQLite and MySQL.
        wanted = " ".join(tag.split()).lower()
        places = [p for p in places if wanted in p.tags]
    return _reads(places, session)


@router.get("/saved-places/tags", response_model=list[TagCount])
def list_tags(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    counts: dict[str, int] = defaultdict(int)
    for tags in session.exec(select(SavedPlace.tags).where(SavedPlace.user_id == user.id)):
        for t in tags or []:
            counts[t] += 1
    return [TagCount(tag=t, count=n) for t, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


@router.post("/saved-places", response_model=SavedPlaceRead, status_code=201)
def create_place(
    payload: SavedPlaceCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if existing := _duplicate(user, payload.place_id, session):
        raise HTTPException(status_code=409, detail=f"You already saved this place as “{existing.name}”")
    collection_ids = _check_collections(payload.collection_ids, user, session)
    place = SavedPlace(**payload.model_dump(exclude={"collection_ids"}), user_id=user.id)  # type: ignore[arg-type]
    stamp_coords(place, utcnow())
    session.add(place)
    session.flush()
    _set_collections(place, collection_ids, session)
    session.commit()
    session.refresh(place)
    return _read(place, session)


@router.get("/saved-places/{saved_id}", response_model=SavedPlaceRead)
def get_place(saved_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    return _read(get_owned_place(saved_id, user, session), session)


@router.patch("/saved-places/{saved_id}", response_model=SavedPlaceRead)
def update_place(
    saved_id: int,
    payload: SavedPlaceUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    place = get_owned_place(saved_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    collection_ids = data.pop("collection_ids", None)
    # null on a required field means "leave it" (null tags would mean "clear":
    # send [] for that). Nullable fields like rating can be cleared with null.
    for key in ("name", "category", "status", "tags"):
        if key in data and data[key] is None:
            del data[key]
    if "place_id" in data and (existing := _duplicate(user, data["place_id"], session, exclude=place.id)):
        raise HTTPException(status_code=409, detail=f"You already saved this place as “{existing.name}”")
    if collection_ids is not None:
        _set_collections(place, _check_collections(collection_ids, user, session), session)

    previous = (place.lat, place.lng, place.place_id)
    place.sqlmodel_update(data)
    stamp_coords(place, utcnow(), previous)
    place.updated_at = utcnow()
    session.add(place)
    session.commit()
    session.refresh(place)
    return _read(place, session)


@router.delete("/saved-places/{saved_id}", status_code=204)
def delete_place(saved_id: int, user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    place = get_owned_place(saved_id, user, session)
    # Stops made from it stay on their trips; they just forget where they came from.
    for stop in session.exec(select(ItineraryItem).where(ItineraryItem.saved_place_id == place.id)):
        stop.saved_place_id = None
        session.add(stop)
    for link in session.exec(select(CollectionPlace).where(CollectionPlace.place_id == place.id)):
        session.delete(link)
    session.delete(place)
    session.commit()


@router.post("/saved-places/{saved_id}/add-to-trip", response_model=ItineraryItemRead, status_code=201)
def add_to_trip(
    saved_id: int,
    payload: AddToTrip,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    place = get_owned_place(saved_id, user, session)
    trip = get_owned_trip(payload.trip_id, user, session)
    if not trip.start_date <= payload.date <= trip.end_date:
        raise HTTPException(
            status_code=422,
            detail=f"{_day(payload.date)} isn't part of {trip.name} "
            f"({_day(trip.start_date)} – {_day(trip.end_date)})",
        )

    # A place in another zone (a day trip across a border, an airport) gets its
    # own zone so the time means local time there. Same zone as the trip: None.
    zone = None
    if place.lat is not None and place.lng is not None:
        try:
            found, _ = zone_for(place.lat, place.lng)
            zone = None if found == trip.timezone else found
        except GeoError:
            zone = None

    stop = ItineraryItem(
        trip_id=trip.id,  # type: ignore[arg-type]
        date=payload.date,
        start_time=payload.start_time,
        title=place.name,
        category=place.category,
        # A Google address must not outlive its 30 days, so it isn't copied
        # into the stop; the stop keeps the place_id and (dated) coordinates.
        location_name=place.address if place.coords_source != "google" else None,
        place_id=place.place_id,
        lat=place.lat,
        lng=place.lng,
        timezone=zone,
        saved_place_id=place.id,
    )
    # Same coordinates, same age: the 30-day clock doesn't restart by copying.
    stop.coords_source = place.coords_source
    stop.coords_fetched_at = place.coords_fetched_at
    session.add(stop)
    session.commit()
    session.refresh(stop)
    return stop


@router.post("/itinerary/{item_id}/save", response_model=SavedPlaceRead)
def save_stop(
    item_id: int,
    response: Response,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Bookmark a stop. Saving the same place twice returns the first save."""
    stop = get_owned_item(item_id, user, session)
    place = session.get(SavedPlace, stop.saved_place_id) if stop.saved_place_id else None
    if place is None or place.user_id != user.id:
        place = _duplicate(user, stop.place_id, session)
    if place is None:
        place = SavedPlace(
            user_id=user.id,  # type: ignore[arg-type]
            name=stop.title[:120],
            category=stop.category,
            address=stop.location_name,
            place_id=stop.place_id,
            lat=stop.lat,
            lng=stop.lng,
        )
        place.coords_source = stop.coords_source
        place.coords_fetched_at = stop.coords_fetched_at
        session.add(place)
        session.flush()
        response.status_code = 201
    stop.saved_place_id = place.id
    session.add(stop)
    session.commit()
    session.refresh(place)
    return _read(place, session)


@router.get("/trips/{trip_id}/saved-places/nearby", response_model=list[NearbySavedPlace])
def nearby_for_trip(
    trip_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Want-to-visit places within ~30 km of any stop on this trip."""
    get_owned_trip(trip_id, user, session)
    stops = [
        s
        for s in session.exec(select(ItineraryItem).where(ItineraryItem.trip_id == trip_id))
        if s.lat is not None and s.lng is not None
    ]
    if not stops:
        return []
    already = {
        s.saved_place_id
        for s in session.exec(select(ItineraryItem).where(ItineraryItem.trip_id == trip_id))
        if s.saved_place_id
    }
    candidates = [
        p
        for p in session.exec(
            select(SavedPlace).where(
                SavedPlace.user_id == user.id,
                SavedPlace.status == PlaceStatus.want,
                SavedPlace.lat.is_not(None),  # type: ignore[union-attr]
                SavedPlace.lng.is_not(None),  # type: ignore[union-attr]
            )
        )
        if p.id not in already
    ]
    hits: list[tuple[float, str, SavedPlace]] = []
    for p in candidates:
        dist, near = min((km_between(p.lat, p.lng, s.lat, s.lng), s.title) for s in stops)  # type: ignore[arg-type]
        if dist <= NEARBY_KM:
            hits.append((dist, near, p))
    hits.sort(key=lambda h: h[0])
    hits = hits[:NEARBY_LIMIT]
    reads = _reads([p for _, _, p in hits], session)
    return [
        NearbySavedPlace(**r.model_dump(), distance_km=round(d, 1), near_stop=near)
        for r, (d, near, _) in zip(reads, hits)
    ]


# ---------------------------------------------------------------------------
# collections
# ---------------------------------------------------------------------------


def _collection_read(coll: Collection, count: int) -> CollectionRead:
    return CollectionRead(id=coll.id, name=coll.name, description=coll.description, place_count=count)  # type: ignore[arg-type]


def _name_taken(user: User, name: str, session: Session, exclude: int | None = None) -> bool:
    q = select(Collection).where(Collection.user_id == user.id, func.lower(Collection.name) == name.strip().lower())
    if exclude is not None:
        q = q.where(Collection.id != exclude)
    return session.exec(q).first() is not None


@router.get("/collections", response_model=list[CollectionRead])
def list_collections(user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(Collection, func.count(CollectionPlace.place_id))
        .join(CollectionPlace, CollectionPlace.collection_id == Collection.id, isouter=True)  # type: ignore[arg-type]
        .where(Collection.user_id == user.id)
        .group_by(Collection.id)
        .order_by(func.lower(Collection.name))
    )
    return [_collection_read(c, n) for c, n in rows]


@router.post("/collections", response_model=CollectionRead, status_code=201)
def create_collection(
    payload: CollectionCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give the collection a name")
    if _name_taken(user, name, session):
        raise HTTPException(status_code=409, detail=f"You already have a collection called “{name}”")
    coll = Collection(name=name, description=payload.description, user_id=user.id)  # type: ignore[arg-type]
    session.add(coll)
    session.commit()
    session.refresh(coll)
    return _collection_read(coll, 0)


@router.patch("/collections/{collection_id}", response_model=CollectionRead)
def update_collection(
    collection_id: int,
    payload: CollectionUpdate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    coll = get_owned_collection(collection_id, user, session)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data:
        if data["name"] is None or not data["name"].strip():
            raise HTTPException(status_code=422, detail="Give the collection a name")
        data["name"] = data["name"].strip()
        if _name_taken(user, data["name"], session, exclude=coll.id):
            raise HTTPException(status_code=409, detail=f"You already have a collection called “{data['name']}”")
    coll.sqlmodel_update(data)
    session.add(coll)
    session.commit()
    session.refresh(coll)
    count = session.exec(
        select(func.count()).select_from(CollectionPlace).where(CollectionPlace.collection_id == coll.id)
    ).one()
    return _collection_read(coll, count)


@router.delete("/collections/{collection_id}", status_code=204)
def delete_collection(
    collection_id: int,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Deletes the collection only; its places stay saved."""
    coll = get_owned_collection(collection_id, user, session)
    for link in session.exec(select(CollectionPlace).where(CollectionPlace.collection_id == coll.id)):
        session.delete(link)
    session.delete(coll)
    session.commit()
