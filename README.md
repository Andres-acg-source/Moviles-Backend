# ParkWise Backend

ParkWise is the shared backend for the Universidad de los Andes campus parking app. The iOS (SwiftUI) and Android (Flutter) apps both use it, so they always see the same data: a spot reserved from iOS shows up as taken on Android on the next request.

The backend is not connected to real sensors. A simulator inside the same process plays the drivers who do not use the app, following a Bogotá weekday/weekend occupancy profile. Everything a real user does (register, reserve, check in, release) is real and changes the state for everyone.

- **Stack:** Node.js 20+, Express 5, TypeScript (ESM), PostgreSQL ([Neon](https://neon.tech)) through `pg`.
- **Parking model:** one campus lot with three levels.

| Level | Location | Zones | Spots |
|---|---|---|---|
| P1 | Ground level | A, B, C | 20 per zone (60) |
| P2 | Underground | A, B | 24 per zone (48) |
| P3 | Underground | A, B | 24 per zone (48) |

Spot ids are global, like `P1-A-01`. In every zone, spot 01 is accessible, 02 is for electric vehicles and 03 is VIP.

The full API contract, with request and response examples, is in [docs/API.md](docs/API.md).

## Project layout

```
migrations/          SQL migrations, applied in order at startup
src/
  server.ts          startup: migrations, seed, simulator, HTTP server, graceful shutdown
  app.ts             Express app (middleware + routers)
  config.ts          environment variables
  db.ts              pg Pool, withTransaction, migration runner
  seed.ts            idempotent seed (levels, 156 spots, buildings, nearby lots)
  time.ts            Bogotá time helpers (UTC-5)
  errors.ts          business error code → [status, message]
  middleware/        auth / optionalAuth, logging, error handling
  routes/            one router per area
  services/          business logic
  analytics/         one file per analytics section / BQ
  simulation/        occupancy source, simulator, history, demo scenarios
scripts/smoke.ts     end-to-end smoke test against a running server
test/                integration tests (one temporary schema per file)
```

## Run locally

Requirements: Node.js 20 or newer and a PostgreSQL database. A free Neon project works.

```powershell
npm ci
Copy-Item .env.example .env
# edit .env: set DATABASE_URL (and TEST_DATABASE_URL to run the tests)
npm run dev
```

On startup, the server does the following:

1. Applies pending migrations.
2. Seeds the catalog if the tables are empty. All spots start `free`.
3. Generates 4 weeks of simulated history the first time.
4. Starts the simulator, which runs a tick every 60 seconds.

The API listens on `http://localhost:3000`.

For an Android emulator, use `http://10.0.2.2:3000`. For a physical device, use the computer's LAN IP.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string. For Neon, use the pooled URL with `sslmode=require` |
| `TEST_DATABASE_URL` | For tests | — | Separate database or Neon branch used only by `npm test` |
| `JWT_SECRET` | In production | Random value per run in development | Secret used to sign tokens. The process refuses to start without it when `NODE_ENV=production` |
| `SIM_KEY` | No | — | Enables `/api/v1/sim/*`. The client sends it in the `X-Sim-Key` header. Without it, those routes return 404 |
| `OCCUPANCY_SOURCE` | No | `simulator` | `simulator`, or `none` to disable the simulator and free every spot it holds on startup |
| `HOLD_MINUTES` | No | `15` | How long a reservation holds a spot before it expires |
| `PORT` | No | `3000` | HTTP port. Render sets it automatically |
| `NODE_ENV` | No | — | `production` on Render. Tests set `test`, which disables the simulator interval and request logs |

## Tests

```powershell
npm test            # integration tests against TEST_DATABASE_URL
npx tsc --noEmit    # type check (src, test and scripts)
npm run build       # compile to dist/
```

Each test file creates its own schema (`test_<random>`) in the `TEST_DATABASE_URL` database, runs the migrations and the seed there, and drops it at the end. Tests never touch `DATABASE_URL`.

With Neon, the tests connect to the direct host (the hostname without `-pooler`), because the pooled endpoint does not keep a per-connection `search_path`.

## Deploy on Render with Neon

1. In Neon, create a project. Copy the **pooled** connection string of the main branch. Optionally, create a second branch for tests.
2. In Render, choose **New → Blueprint** and point it at this repository. Render reads [`render.yaml`](render.yaml), which defines one web service with:
   - build `npm ci --include=dev && npm run build`;
   - start `npm start`;
   - health check `/health`;
   - `NODE_ENV=production`, `OCCUPANCY_SOURCE=none` and `HOLD_MINUTES=15`;
   - a generated `JWT_SECRET` and `SIM_KEY`.
3. When Render asks for `DATABASE_URL`, paste the Neon pooled URL.
4. Deploy. The first boot creates the tables, seeds the lot and generates 4 weeks of history, which takes a few seconds. After that, `/health` should return `{ "status": "ok", "db": "ok" }`.
5. Run the smoke test against the deployed URL:

   ```powershell
   npm run smoke -- https://<your-service>.onrender.com
   ```

The simulator runs inside the web service. On Render's free plan, the service sleeps when it is idle, so the simulator pauses too. The first request after a sleep wakes it up, and a tick runs immediately.

## Demo scenarios

Use the `SIM_KEY` value from the Render dashboard (Environment tab).

Fill the whole campus for 15 minutes, for example to demo the "campus full" flow and BQ4:

```bash
curl -X POST https://<service>/api/v1/sim/scenario \
  -H "X-Sim-Key: $SIM_KEY" -H "Content-Type: application/json" \
  -d '{"occupancy": 100, "minutes": 15}'
```

Empty only level P2:

```bash
curl -X POST https://<service>/api/v1/sim/scenario \
  -H "X-Sim-Key: $SIM_KEY" -H "Content-Type: application/json" \
  -d '{"level": "P2", "occupancy": 0}'
```

Go back to the normal profile:

```bash
curl -X POST https://<service>/api/v1/sim/reset -H "X-Sim-Key: $SIM_KEY"
```

Scenarios never change spots that are reserved or occupied by real users. They are kept in memory, so they also end when the service restarts.
