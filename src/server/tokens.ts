import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PersistenceError } from './expense-repository.ts';
export function validToken(token: unknown): token is string {
  return typeof token==='string' && token.length===43 && /^[A-Za-z0-9_-]+$/.test(token)
    && Buffer.from(token,'base64url').length===32 && Buffer.from(token,'base64url').toString('base64url')===token;
}
export function hashToken(token: string): string {
  if (!validToken(token)) throw new PersistenceError('UNAUTHORIZED');
  return createHash('sha256').update(token,'utf8').digest('hex');
}
export function newToken() { return randomBytes(32).toString('base64url'); }
export function csrfToken(session: string) {
  if (!validToken(session)) throw new PersistenceError('UNAUTHORIZED');
  return createHmac('sha256',session).update('cusco-csrf-v1').digest('base64url');
}
export function verifyCsrf(session: string, provided: string | null) {
  if (!validToken(provided) || !timingSafeEqual(Buffer.from(csrfToken(session)),Buffer.from(provided))) throw new PersistenceError('FORBIDDEN');
}
export const SESSION_COOKIE='__Host-cusco_session';
export function sessionCookie(token: string,maxAge=28800) {
  if (!validToken(token)) throw new PersistenceError('UNAUTHORIZED');
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export const expiredSessionCookie=`${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
export function readSessionCookie(request: Request) {
  const values=(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(SESSION_COOKIE+'='));
  if(values.length!==1) throw new PersistenceError('UNAUTHORIZED');
  const token=values[0].slice(SESSION_COOKIE.length+1);
  if(!validToken(token)) throw new PersistenceError('UNAUTHORIZED');
  return token;
}
export function ipQuotaHash(request: Request,secret: string,vercel: boolean) {
  if(secret.length<32) throw new PersistenceError('UNAVAILABLE');
  // Solo el header sobrescrito por Vercel. En otro host no confiar en headers aportados por clientes.
  const ip=vercel ? (request.headers.get('x-vercel-forwarded-for')??'unknown').split(',')[0].trim().slice(0,128) : 'unknown';
  return createHmac('sha256',secret).update('ip:'+ip).digest('hex');
}
