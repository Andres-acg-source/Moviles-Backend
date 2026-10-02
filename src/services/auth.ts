import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scryptAsync(password, salt, KEY_LENGTH)).toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = await scryptAsync(password, salt, KEY_LENGTH);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

interface UserRow { id: string; email: string; name: string | null; password_hash: string }

export const profileOf = (user: { id: string; email: string; name: string | null }) => ({ id: user.id, email: user.email, name: user.name ?? '' });

export async function register(email: string, password: string, name?: string) {
  const { rows } = await db().query<UserRow>(
    'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING RETURNING id, email, name',
    [email.toLowerCase(), name ?? null, await hashPassword(password)]
  );
  if (!rows[0]) throw new Error('EMAIL_EXISTS');
  return profileOf(rows[0]);
}

export async function login(email: string, password: string) {
  const { rows } = await db().query<UserRow>('SELECT id, email, name, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) throw new Error('INVALID_CREDENTIALS');
  return profileOf(user);
}

export async function profile(userId: string) {
  const { rows } = await db().query<UserRow>('SELECT id, email, name FROM users WHERE id = $1', [userId]);
  if (!rows[0]) throw new Error('USER_NOT_FOUND');
  return profileOf(rows[0]);
}
