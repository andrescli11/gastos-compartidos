import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { PersistenceError } from "./expense-repository.ts";
const format = /^scrypt1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
export const validPin = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{3}$/.test(value);
export function validPinVerifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = format.exec(value);
  return (
    !!match &&
    Buffer.from(match[1], "base64url").toString("base64url") === match[1] &&
    Buffer.from(match[2], "base64url").toString("base64url") === match[2]
  );
}
function material(pin: string, id: string, secret: string) {
  if (secret.length < 32) throw new PersistenceError("UNAVAILABLE");
  if (!validPin(pin)) throw new PersistenceError("INVALID_INPUT");
  return createHmac("sha256", secret)
    .update(`cusco-pin-material-v1\0${id.toLowerCase()}\0${pin}`)
    .digest();
}
async function derive(input: Buffer, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(
      input,
      salt,
      64,
      { N: 16384, r: 8, p: 1, maxmem: 33554432 },
      (error, result) =>
        error ? reject(new PersistenceError("UNAVAILABLE")) : resolve(result),
    ),
  );
}
export function pinManagementSalt(
  secret: string,
  actorHash: string,
  key: string,
  id: string,
) {
  if (secret.length < 32) throw new PersistenceError("UNAVAILABLE");
  return createHmac("sha256", secret)
    .update(
      `cusco-pin-salt-v1\0${actorHash}\0${key.toLowerCase()}\0${id.toLowerCase()}`,
    )
    .digest()
    .subarray(0, 16);
}
export async function hashPin(
  pin: string,
  id: string,
  secret: string,
  salt = randomBytes(16),
) {
  if (salt.length !== 16) throw new PersistenceError("INVALID_INPUT");
  const key = await derive(material(pin, id, secret), salt);
  return `scrypt1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyPin(
  pin: string,
  id: string,
  secret: string,
  verifier: unknown,
) {
  // Use identical KDF parameters even for an unknown/disabled account.
  const encoded = validPinVerifier(verifier)
    ? verifier
    : `scrypt1$${Buffer.alloc(16).toString("base64url")}$${Buffer.alloc(64).toString("base64url")}`;
  const [, salt, hash] = encoded.split("$");
  const candidate = await derive(
    material(pin, id, secret),
    Buffer.from(salt, "base64url"),
  );
  return (
    timingSafeEqual(candidate, Buffer.from(hash, "base64url")) &&
    validPinVerifier(verifier)
  );
}
