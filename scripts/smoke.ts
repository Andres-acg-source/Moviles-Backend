import { randomBytes } from 'node:crypto';

const base = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? '').replace(/\/+$/, '');
if (!base) {
  console.error('Usage: npm run smoke -- <BASE_URL>');
  process.exit(1);
}

interface Response<T = any> { status: number; body: T }

async function call<T = any>(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Response<T>> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    failures++;
    console.log(`✘ ${name}: ${error instanceof Error ? error.message : error}`);
  }
}

const suffix = randomBytes(4).toString('hex');
const users: Array<{ token: string; id: string }> = [];
let spot: { id: string; levelCode: string } | undefined;
let winner: { token: string; id: string } | undefined;
let reservationId: string | undefined;

await step('register two users', async () => {
  for (const index of [1, 2]) {
    const response = await call('POST', '/api/v1/auth/register', { body: { name: `Smoke ${index}`, email: `smoke-${suffix}-${index}@parkwise.test`, password: `smoke-${suffix}` } });
    expect(response.status === 201, `register returned ${response.status}`);
    users.push({ token: response.body.token, id: response.body.user.id });
  }
});

await step('GET /health', async () => {
  const response = await call('GET', '/health');
  expect(response.status === 200 && response.body.db === 'ok', `health returned ${response.status} ${JSON.stringify(response.body)}`);
});

await step('GET /levels', async () => {
  const response = await call('GET', '/api/v1/levels');
  expect(response.status === 200 && response.body.levels.length === 3, `levels returned ${response.status}`);
  const level = response.body.levels.find((item: { free: number }) => item.free > 0);
  expect(level, 'no level has free spots');
  const spots = await call('GET', `/api/v1/levels/${level.code}/spots?available=true`);
  expect(spots.status === 200 && spots.body.length > 0, 'no free spot found');
  spot = { id: spots.body[0].id, levelCode: level.code };
});

await step('concurrent reservations: one 201 and one 409', async () => {
  expect(spot && users.length === 2, 'missing users or spot');
  const responses = await Promise.all(users.map(user => call('POST', '/api/v1/reservations', { token: user.token, body: { spotId: spot!.id } })));
  const statuses = responses.map(response => response.status).sort();
  expect(statuses[0] === 201 && statuses[1] === 409, `statuses were ${statuses.join(', ')}`);
  const index = responses.findIndex(response => response.status === 201);
  winner = users[index];
  reservationId = responses[index].body.id;
});

await step('check in and GET /vehicle', async () => {
  expect(winner && reservationId, 'no reservation to check in');
  const checkIn = await call('POST', `/api/v1/reservations/${reservationId}/check-in`, { token: winner.token });
  expect(checkIn.status === 200 && checkIn.body.status === 'fulfilled', `check-in returned ${checkIn.status}`);
  const vehicle = await call('GET', '/api/v1/vehicle', { token: winner.token });
  expect(vehicle.status === 200 && vehicle.body?.spotId === spot!.id, `vehicle returned ${JSON.stringify(vehicle.body)}`);
});

await step('release frees the spot', async () => {
  expect(winner && reservationId, 'no reservation to release');
  const released = await call('POST', `/api/v1/reservations/${reservationId}/release`, { token: winner.token });
  expect(released.status === 200 && released.body.status === 'released', `release returned ${released.status}`);
  const spots = await call('GET', `/api/v1/levels/${spot!.levelCode}/spots`, { token: winner.token });
  const current = spots.body.find((item: { id: string }) => item.id === spot!.id);
  expect(current && !current.mine, 'spot is still held by the user');
  expect(current.status === 'free', `spot status is ${current.status}`);
});

await step('GET /predictions', async () => {
  const response = await call('GET', '/api/v1/predictions');
  expect(response.status === 200 && response.body.levels.length === 3, `predictions returned ${response.status}`);
});

await step('GET /recommendations/level', async () => {
  const response = await call('GET', '/api/v1/recommendations/level');
  expect(response.status === 200 && Array.isArray(response.body.levels), `recommendations returned ${response.status}`);
});

await step('GET /analytics/summary', async () => {
  const response = await call('GET', '/api/v1/analytics/summary', { token: users[0]?.token });
  expect(response.status === 200 && response.body.parking.total > 0, `analytics returned ${response.status}`);
});

console.log(failures ? `\n${failures} step(s) failed` : '\nAll smoke steps passed');
process.exit(failures ? 1 : 0);
