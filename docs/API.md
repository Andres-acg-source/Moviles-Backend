# ParkWise API v1

Contract shared by the iOS (SwiftUI) and Android (Flutter) apps. Both apps read the same database, so a change made from one app is visible from the other on the next request.

- Base URL: `https://<render-service>.onrender.com` (local: `http://localhost:3000`).
- Every route lives under `/api/v1`, except `GET /health`.
- Request and response bodies are JSON (`Content-Type: application/json`). Bodies larger than 100 kB are rejected with 413.
- Timestamps are ISO 8601 in UTC (`2026-10-01T14:05:00.000Z`). Business hours, 15-minute slots and weekdays are computed in Bogotá time (UTC-5, no daylight saving time).
- Weekdays use `0 = Sunday … 6 = Saturday`.

## Authentication

Send the token returned by register/login in the `Authorization` header:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Tokens last 7 days. The header must start with `Bearer `. A token is rejected with 401 if it is malformed, expired, signed with another algorithm, or if the user no longer exists.

- **JWT: Yes** means the token is required.
- **JWT: Optional** means the route works without a token. With a valid token, the response is personalized (`mine`) or attributed to the user (telemetry, unmet demand). An invalid token is ignored on these routes.

## Errors

Every error is JSON:

```json
{ "error": "Parking spot is not available" }
```

Validation errors (400) also include `details`:

```json
{
  "error": "Invalid request",
  "details": { "formErrors": [], "fieldErrors": { "password": ["String must contain at least 6 character(s)"] } }
}
```

| Status | When |
|---|---|
| 400 | Invalid body or query (`Invalid request`), malformed JSON (`Malformed JSON`), unknown destination, invalid date |
| 401 | Missing or invalid token, wrong credentials, deleted user |
| 403 | Wrong `X-Sim-Key` |
| 404 | Unknown route (`Not found`), level, spot or reservation |
| 409 | Email already registered, spot not free, an active reservation already exists, reservation expired, not active or already closed |
| 413 | Body larger than 100 kB |
| 429 | Rate limit exceeded (`Too many requests`) |
| 500 | Unexpected error (`Internal server error`) |
| 503 | `/health` only: the database is not reachable |

Rate limits are applied per IP: 10 requests per minute on `/auth/login` and `/auth/register`, and 120 per minute on `/telemetry`. Responses include the standard `RateLimit` and `RateLimit-Policy` headers.

## Reservation object

All reservation endpoints return this shape:

```json
{
  "id": "8d0e6a43-35b5-4c39-9f57-0f2f0e9a0c11",
  "spotId": "P1-A-07",
  "spotCode": "A-07",
  "levelCode": "P1",
  "status": "active",
  "createdAt": "2026-10-01T14:05:00.000Z",
  "expiresAt": "2026-10-01T14:20:00.000Z",
  "checkedInAt": null,
  "releasedAt": null
}
```

| status | Meaning |
|---|---|
| `active` | Spot held for the user until `expiresAt` (`HOLD_MINUTES`, 15 by default) |
| `fulfilled` | The user checked in; the spot is occupied by them |
| `released` | The user left after checking in |
| `cancelled` | The user released the reservation before checking in |
| `expired` | Nobody checked in before `expiresAt`; the spot went back to free |

---

## Health

### GET /health

JWT: No.

```http
GET /health
```

```json
200 { "status": "ok", "db": "ok" }
503 { "status": "error", "db": "unavailable" }
```

## Auth

### POST /api/v1/auth/register

JWT: No. Rate limited.

| Field | Rules |
|---|---|
| `email` | Valid email. It is trimmed and lowercased |
| `password` | 6 to 128 characters |
| `name` | Optional, 1 to 80 characters |

```http
POST /api/v1/auth/register
Content-Type: application/json

{ "name": "Laura", "email": "laura@uniandes.edu.co", "password": "secret123" }
```

```json
201
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "id": "3f1c2b8e-8b0a-4e43-9a43-2d5a3e6f7c10", "email": "laura@uniandes.edu.co", "name": "Laura" }
}
```

Errors: 400 for validation, 409 `Email already registered`, 429.

### POST /api/v1/auth/login

JWT: No. Rate limited. `password` must be 1 to 128 characters.

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "email": "laura@uniandes.edu.co", "password": "secret123" }
```

```json
200 { "token": "eyJhbGciOi...", "user": { "id": "3f1c2b8e-...", "email": "laura@uniandes.edu.co", "name": "Laura" } }
```

Errors: 400, 401 `Invalid credentials`, 429.

### GET /api/v1/auth/me

JWT: Yes.

```json
200 { "id": "3f1c2b8e-8b0a-4e43-9a43-2d5a3e6f7c10", "email": "laura@uniandes.edu.co", "name": "Laura" }
```

`name` is `""` when the user did not provide one.

## Catalog and levels

### GET /api/v1/buildings

JWT: No. These are the destinations used for walking times.

```json
200
[
  { "id": "biblioteca", "name": "Biblioteca General" },
  { "id": "deportivo", "name": "Centro Deportivo" },
  { "id": "ml", "name": "Edificio Mario Laserna" },
  { "id": "sd", "name": "Edificio Santo Domingo" }
]
```

### GET /api/v1/levels?zone=

JWT: Optional.

| Query | Description |
|---|---|
| `zone` | Optional. The user's rounded location as `lat,lng` with 2 decimals, for example `4.60,-74.07`. When the campus is full and the request has a valid token, the backend records one unmet-demand entry per user and 15-minute slot (BQ4) |

`total` excludes `disabled` spots. `campusFull` is `true` when no level has a `free` spot.

```http
GET /api/v1/levels?zone=4.60,-74.07
Authorization: Bearer eyJhbGciOi...
```

```json
200
{
  "generatedAt": "2026-10-02T04:35:41.070Z",
  "campusFull": false,
  "levels": [
    { "code": "P1", "name": "Level P1", "underground": false, "total": 60, "free": 52, "reserved": 0, "occupied": 8 },
    { "code": "P2", "name": "Level P2", "underground": true, "total": 48, "free": 43, "reserved": 0, "occupied": 5 },
    { "code": "P3", "name": "Level P3", "underground": true, "total": 48, "free": 45, "reserved": 0, "occupied": 3 }
  ]
}
```

### GET /api/v1/levels/:code/spots

JWT: Optional (needed for `mine`).

| Query | Description |
|---|---|
| `destination` | Building id used for `walkMinutes`. Default `ml` |
| `available=true` | Only `free` spots |
| `accessible=true` | Only accessible spots |
| `ev=true` | Only electric-vehicle spots |
| `vip=true` | Only VIP spots |

Filters are active only when the value is exactly `"true"`. Spots are sorted by zone and code.

`walkMinutes = ceil((distance from the spot to the building entrance ÷ 1.3 m/s + 60 s per underground level) ÷ 60)`.

`status` is one of `free`, `reserved`, `occupied` or `disabled`. `mine` is `true` only for the spot held by the token's user.

```http
GET /api/v1/levels/P1/spots?destination=sd&accessible=true
Authorization: Bearer eyJhbGciOi...
```

```json
200
[
  { "id": "P1-A-01", "code": "A-01", "zone": "A", "levelCode": "P1", "status": "free", "isAccessible": true, "isEv": false, "isVip": false, "walkMinutes": 3, "mine": false },
  { "id": "P1-B-01", "code": "B-01", "zone": "B", "levelCode": "P1", "status": "reserved", "isAccessible": true, "isEv": false, "isVip": false, "walkMinutes": 3, "mine": true },
  { "id": "P1-C-01", "code": "C-01", "zone": "C", "levelCode": "P1", "status": "occupied", "isAccessible": true, "isEv": false, "isVip": false, "walkMinutes": 3, "mine": false }
]
```

Errors: 404 `Level not found`, 400 `Destination building not found`.

## Reservations

### POST /api/v1/reservations

JWT: Yes.

```http
POST /api/v1/reservations
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "spotId": "P1-A-07" }
```

`201` returns a Reservation with `status: "active"`. The spot becomes `reserved`, and other users see it as taken immediately. When two users reserve the same spot at the same time, exactly one gets 201 and the other gets 409.

Errors: 400 if `spotId` is missing, 404 `Parking spot not found`, 409 `Parking spot is not available`, 409 `An active reservation already exists`.

### POST /api/v1/reservations/:id/check-in

JWT: Yes. Only the owner of the reservation can check in.

```http
POST /api/v1/reservations/8d0e6a43-35b5-4c39-9f57-0f2f0e9a0c11/check-in
Authorization: Bearer eyJhbGciOi...
```

```json
200
{
  "id": "8d0e6a43-35b5-4c39-9f57-0f2f0e9a0c11",
  "spotId": "P1-A-07", "spotCode": "A-07", "levelCode": "P1",
  "status": "fulfilled",
  "createdAt": "2026-10-01T14:05:00.000Z",
  "expiresAt": "2026-10-01T14:20:00.000Z",
  "checkedInAt": "2026-10-01T14:12:31.000Z",
  "releasedAt": null
}
```

Errors: 404 `Reservation not found` (it does not exist or belongs to someone else), 409 `Reservation has expired`, 409 `Reservation is not active`.

### POST /api/v1/reservations/:id/release

JWT: Yes. Only the owner can release.

- An `active` reservation becomes `cancelled`.
- A `fulfilled` reservation becomes `released`.

In both cases `releasedAt` is set and the spot goes back to `free`.

```json
200 { "id": "8d0e6a43-...", "spotId": "P1-A-07", "spotCode": "A-07", "levelCode": "P1", "status": "released", "createdAt": "...", "expiresAt": "...", "checkedInAt": "2026-10-01T14:12:31.000Z", "releasedAt": "2026-10-01T17:40:02.000Z" }
```

Errors: 404, 409 `Reservation is already closed`.

### GET /api/v1/reservations/active

JWT: Yes. Returns the user's open reservation (`active` and not yet expired, or `fulfilled` without `releasedAt`), or `null`.

```json
200 { "id": "8d0e6a43-...", "spotId": "P1-A-07", "spotCode": "A-07", "levelCode": "P1", "status": "active", "createdAt": "...", "expiresAt": "...", "checkedInAt": null, "releasedAt": null }
200 null
```

### GET /api/v1/reservations/me

JWT: Yes. Returns `Reservation[]`, newest first, with at most 50 items.

### GET /api/v1/vehicle

JWT: Yes. Returns where the user's car is parked, based on the fulfilled reservation that has not been released, or `null`.

```json
200 { "spotId": "P1-A-07", "spotCode": "A-07", "levelCode": "P1", "zone": "A", "parkedAt": "2026-10-01T14:12:31.000Z" }
200 null
```

### GET /api/v1/nearby-lots

JWT: No. Returns off-campus alternatives. There is no live availability for them.

```json
200
[
  { "id": "nearby-1", "name": "Park Central", "address": "Calle  ejercito 18", "ratePerHour": 6000, "currency": "COP", "walkMinutes": 6 },
  { "id": "nearby-2", "name": "City Parking", "address": "Carrera 1 19-20", "ratePerHour": 7500, "currency": "COP", "walkMinutes": 9 }
]
```

## Prediction and recommendations

### GET /api/v1/predictions?level=&date=

JWT: No.

| Query | Description |
|---|---|
| `date` | `YYYY-MM-DD`. Default: today in Bogotá |
| `level` | Optional level code |

For each 15-minute slot, `occupancy` is the average of `(occupied + reserved) / total` over the snapshots taken on the same weekday and slot during the 4 weeks before the date. The window ends at that date's midnight, or now if that comes earlier. `occupancy` is a fraction from 0 to 1, or `null` when there is no data. Each level has 96 points.

```http
GET /api/v1/predictions?date=2026-10-05&level=P1
```

```json
200
{
  "date": "2026-10-05",
  "intervalMinutes": 15,
  "levels": [
    { "code": "P1", "points": [ { "slot": "00:00", "occupancy": 0.1 }, { "slot": "00:15", "occupancy": 0.083 }, "…", { "slot": "10:00", "occupancy": 0.95 }, "…", { "slot": "23:45", "occupancy": 0.1 } ] }
  ]
}
```

Errors: 400 `Invalid date, expected YYYY-MM-DD`, 404 `Level not found`.

### GET /api/v1/recommendations/level?arrivalAt=

JWT: No. `arrivalAt` is an ISO date-time; the default is now + 20 minutes. Returns the level with the lowest predicted occupancy in the arrival slot. `recommended` is `null` when there is no history.

```http
GET /api/v1/recommendations/level?arrivalAt=2026-10-02T13:05:00Z
```

```json
200
{
  "arrivalAt": "2026-10-02T13:05:00.000Z",
  "slot": "08:00",
  "recommended": "P3",
  "levels": [
    { "code": "P1", "predictedOccupancy": 0.95 },
    { "code": "P2", "predictedOccupancy": 0.854 },
    { "code": "P3", "predictedOccupancy": 0.76 }
  ]
}
```

Errors: 400 `Invalid arrivalAt, expected an ISO date-time`.

### GET /api/v1/recommendations/lead-time (BQ6)

JWT: Yes. This uses only the user's own reservations.

- The travel time of a check-in is `checkedInAt − createdAt`.
- An expired reservation counts as `holdMinutes + 5`.
- Cancelled reservations are ignored.
- `suggestedReserveAfterLeavingMinutes = max(0, p80TravelMinutes − holdMinutes)`.

```json
200
{
  "reservationsConsidered": 4,
  "holdMinutes": 15,
  "p80TravelMinutes": 24,
  "expiredCount": 1,
  "suggestedReserveAfterLeavingMinutes": 9,
  "message": "Your trips take up to 24 minutes, so reserve about 9 minutes after leaving to arrive before the 15-minute hold expires."
}
```

With fewer than 3 reservations, `p80TravelMinutes`, `expiredCount` and `suggestedReserveAfterLeavingMinutes` are `null` and `message` is a default text.

## Telemetry and analytics

### POST /api/v1/telemetry

JWT: Optional. When the token is valid, the event is stored with the user id. This is required for `app_opened` to count toward BQ3. Rate limited.

| Field | Rules |
|---|---|
| `name` | snake_case, 1 to 100 characters (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`) |
| `properties` | Optional object with at most 20 keys. Keys have 1 to 40 characters. Values are a string of up to 200 characters, a number or a boolean |

```http
POST /api/v1/telemetry
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "name": "map_loaded", "properties": { "levelCode": "P1", "durationMs": 420, "success": true, "deviceModel": "iPhone 15", "osVersion": "18.1", "platform": "ios" } }
```

```json
202 { "accepted": true }
```

Events used by the analytics:

| Event | Properties | Business question |
|---|---|---|
| `map_loaded` | `levelCode`, `durationMs`, `success`, `errorType?`, `deviceModel`, `osVersion`, `platform` | BQ1 |
| `walking_time_viewed` | `levelCode`, `minutes`, `spotCode?`, `source?` | BQ2 |
| `app_opened` | `platform?` (send with the token) | BQ3 |
| `filter_applied` | `filter`: `available` \| `vip` \| `electric` \| `accessible` | BQ3 |

### GET /api/v1/analytics/summary

JWT: Yes.

```json
200
{
  "generatedAt": "2026-10-02T04:35:42.000Z",
  "eventCounts": { "map_loaded": 11, "walking_time_viewed": 3 },
  "parking": { "total": 156, "free": 140, "reserved": 0, "occupied": 16, "accessibleFree": 7, "evFree": 6 },
  "reservations": {
    "user": { "active": 1, "fulfilled": 0, "released": 3, "cancelled": 1, "expired": 0 },
    "sim": { "active": 2, "fulfilled": 5, "released": 6120, "cancelled": 0, "expired": 1530 },
    "total": { "active": 3, "fulfilled": 5, "released": 6123, "cancelled": 1, "expired": 1530 }
  },
  "walkingTime": { "views": 3, "averageMinutes": 3.7, "byLevel": { "P1": { "views": 2, "averageMinutes": 2.5 }, "P2": { "views": 1, "averageMinutes": 6 } } },
  "mapLoad": [
    { "deviceModel": "iPhone 15", "osVersion": "18.1", "levelCode": "P1", "loads": 10, "avgMs": 550, "p90Ms": 910, "failureRate": 0.2 }
  ],
  "filterUsage": {
    "month": "2026-10",
    "activeUsers": 4,
    "filters": {
      "available": { "uses": 3, "usesPerActiveUser": 0.75, "percentNeverUsed": 50 },
      "vip": { "uses": 1, "usesPerActiveUser": 0.25, "percentNeverUsed": 75 },
      "electric": { "uses": 1, "usesPerActiveUser": 0.25, "percentNeverUsed": 100 },
      "accessible": { "uses": 0, "usesPerActiveUser": 0, "percentNeverUsed": 100 }
    }
  },
  "unmetDemand": { "total": 2, "rows": [ { "weekday": 4, "slot": "08:15", "zone": "4.60,-74.07", "count": 2 } ] },
  "reservationPolicy": {
    "windowDays": 28,
    "holdMinutes": 15,
    "rows": [
      {
        "levelCode": "P1", "slot": "08:00",
        "user": { "created": 2, "fulfilled": 1, "expired": 1, "noShowRate": 0.5, "p90CheckInMinutes": 5, "recommendedWindowMinutes": 10, "heldSpots": 0 },
        "sim": { "created": 14, "fulfilled": 10, "expired": 4, "noShowRate": 0.286, "p90CheckInMinutes": 12.2, "recommendedWindowMinutes": 10, "heldSpots": 0 },
        "total": { "created": 16, "fulfilled": 11, "expired": 5, "noShowRate": 0.313, "p90CheckInMinutes": 12.1, "recommendedWindowMinutes": 10, "heldSpots": 0 }
      }
    ]
  }
}
```

Section notes:

| Section | Notes |
|---|---|
| `parking` | Current spot counts. `total` excludes disabled spots |
| `reservations` | All-time reservation counts by status, split by source (`user` and `sim`) |
| `mapLoad` (BQ1) | Grouped by `deviceModel` + `osVersion` + `levelCode`. `p90Ms` uses `percentile_cont(0.9)`. `failureRate` is the share of loads with `success: false` |
| `filterUsage` (BQ3) | Current Bogotá month. `activeUsers` counts distinct users who sent `app_opened` with a token. `percentNeverUsed` is the percentage of active users who never applied that filter this month |
| `unmetDemand` (BQ4) | Times a logged-in user saw a full campus, counted once per user and 15-minute slot. User ids are not exposed |
| `reservationPolicy` (BQ5) | Last 28 days, by level and creation slot. See below |

`reservationPolicy` fields:

- `fulfilled` counts the reservations that were checked in, including those that were later released.
- `noShowRate = expired ÷ created`.
- `recommendedWindowMinutes` is the p90 check-in time rounded to a multiple of 5 and kept between 10 and 30. It is `null` without check-ins.
- `heldSpots = round(created per day × (1 − noShowRate))`, capped at the average number of free spots in that slot.

## Simulator (demo only)

Both routes require the header `X-Sim-Key: <SIM_KEY>`. A wrong key returns 403. When `SIM_KEY` is not configured, both routes return 404.

### POST /api/v1/sim/scenario

| Field | Rules |
|---|---|
| `level` | Optional. Without it, the scenario applies to all levels |
| `occupancy` | 0 to 100 |
| `minutes` | 1 to 120, default 10 |

Spots held by real users are never touched.

```http
POST /api/v1/sim/scenario
X-Sim-Key: <SIM_KEY>
Content-Type: application/json

{ "occupancy": 100, "minutes": 15 }
```

```json
200 { "applied": true, "until": "2026-10-02T14:20:00.000Z" }
```

Errors: 400, 403, 404 (simulator disabled or unknown level).

### POST /api/v1/sim/reset

Removes every scenario and returns to the normal profile immediately.

```json
200 { "reset": true }
```
