# ParkWise Backend

REST API for the ParkWise Flutter application in `Rodri45/Moviles-Dart`.
The service follows an MVVM-oriented backend structure: domain models are stored by the repository layer, application services own business rules, and view models shape responses to match the Dart entities.

## Run locally

Requirements: Node.js 20 or newer.

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The API runs at `http://localhost:3000`. Data is persisted in `data/parkwise.json` so no database server is needed for local development. Set `DATA_FILE` to use another location and replace `JWT_SECRET` before deploying.

## API contract

Public endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Service health check |
| POST | `/api/v1/auth/register` | Create an account (`email`, `password`, optional `name`) |
| POST | `/api/v1/auth/login` | Get a JWT (`email`, `password`) |
| GET | `/api/v1/lots` | List lots with levels and spot state |
| GET | `/api/v1/lots/:lotId` | Get one lot |
| GET | `/api/v1/lots/:lotId/forecast` | Get hourly occupancy forecast |
| GET | `/api/v1/spots/search` | Search/filter spots with `q`, `available`, `accessible`, `ev`, `vip`, and `lotId` |
| GET | `/api/v1/nearby-lots` | List verified off-campus overflow lots, rates, capacity, and walk time |
| GET | `/api/v1/lots/:lotId/queue` | Get waiting vehicles and observed exit rate |
| GET | `/api/v1/lots/:lotId/patterns` | Get historical-pattern-compatible occupancy data |

Authenticated endpoints require `Authorization: Bearer <token>`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/auth/me` | Validate the token and return the current user (`id`, `email`, `name`) |
| GET | `/api/v1/reservations/active` | Get the current user's active reservation |
| POST | `/api/v1/reservations` | Reserve a free spot (`lotId`, `spotId`, `durationMinutes`) |
| DELETE | `/api/v1/reservations/:reservationId` | Cancel a reservation |
| POST | `/api/v1/reservations/:reservationId/check-in` | Fulfill a reservation and assign the parked vehicle location |
| POST | `/api/v1/check-out` | Release the parked spot and clear the vehicle location |
| GET | `/api/v1/vehicle` | Get the user's parked vehicle |
| PUT | `/api/v1/vehicle` | Save parked vehicle location |
| DELETE | `/api/v1/vehicle` | Clear parked vehicle location |
| GET/PUT | `/api/v1/permit` | Read or update a standard, accessible, or EV permit |
| POST | `/api/v1/payments` | Record an idempotent reservation or extension payment |
| POST | `/api/v1/departure-recommendation` | Calculate a leave time from arrival, travel time, and forecast |
| POST | `/api/v1/telemetry` | Accept privacy-conscious product events |
| GET | `/api/v1/analytics/summary` | Return aggregate parking, reservation, and event metrics, plus `walkingTime` (BQ2: views and average minutes from `walking_time_viewed` events, total and by level) |

Additional authenticated action: `POST /api/v1/spots/:lotId/:spotId/report-stale` re-verifies an occupied spot reported as empty.

The lot, level, spot, forecast, reservation, and parked vehicle JSON fields use the same lowerCamelCase names as the Dart domain entities. `GET /api/v1/lots` additionally returns `totalSpots` and `freeSpots` for the existing UI calculations.

The backend now supplies the data boundaries needed by the wiki scenarios: specialized accessible/EV/VIP filtering, walking-time labels, level forecasts, overflow parking, queue visibility, check-in/check-out, permit records, payment idempotency, departure recommendations, stale reports, telemetry, and aggregate analytics. Payment gateway, campus sensor, geofencing, routing, and push-notification providers are intentionally integration boundaries; the API models the events and state they must update without claiming a live third-party connection.

## Flutter connection

Add an HTTP client such as `http` to the Dart app and implement the existing ports in `lib/infrastructure/http/`:

- `ParkingRepository`: `GET /api/v1/lots`, `GET /api/v1/lots/{id}`, and `GET /api/v1/lots/{id}/forecast`.
- `ReservationRepository`: the active, create, and cancel reservation endpoints.
- `VehicleLocator`: the vehicle GET, PUT, and DELETE endpoints.

Keep the JWT returned by register/login and send it in the `Authorization` header for the authenticated ports. For an Android emulator, use `http://10.0.2.2:3000`; for a physical device, use the computer's LAN IP and allow port 3000 through the local firewall.

## Verification

```powershell
npm run build
npm test
```
# Moviles-Backend