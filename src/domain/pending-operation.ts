import type { ExpenseCommand } from "../server/expense-repository.ts";
export type PendingOperation<T = ExpenseCommand> = { key: string; command: T };
export type PendingScope = "expenses" | "payments";
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function storageName(scope: PendingScope) {
  return scope === "payments"
    ? "cusco.pending.payments.v1"
    : "cusco.pending.v1";
}
const encoder = new TextEncoder();
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes));
}
function decode(value: string) {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
async function encryptionKey(csrf: string) {
  if (csrf.length !== 43)
    throw new Error("No se pudo preparar la recuperación privada.");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode("cusco-pending-v1:" + csrf),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
/** Solo después de confirmar: diario cifrado en sessionStorage; clave nunca persistida. */
export async function rememberPending<T = ExpenseCommand>(
  pending: PendingOperation<T>,
  csrf: string,
  storage: Store,
  scope: PendingScope = "expenses",
) {
  const name = storageName(scope);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const text = JSON.stringify({
    version: 1,
    expiresAt: Date.now() + 8 * 60 * 60 * 1000,
    ...pending,
  });
  if (encoder.encode(text).length > 65536)
    throw new Error("La operación excede el límite admitido.");
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
    await encryptionKey(csrf),
    encoder.encode(text),
  );
  storage.setItem(
    name,
    JSON.stringify({
      iv: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    }),
  );
}
export function forgetPending(
  storage: Store,
  scope: PendingScope = "expenses",
) {
  storage.removeItem(storageName(scope));
}
export async function recoverPending<T = ExpenseCommand>(
  csrf: string,
  storage: Store,
  scope: PendingScope = "expenses",
): Promise<PendingOperation<T> | null> {
  const name = storageName(scope);
  const saved = storage.getItem(name);
  if (!saved) return null;
  try {
    if (saved.length > 100000) throw new Error();
    const envelope = JSON.parse(saved);
    if (
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    )
      throw new Error();
    const iv = decode(envelope.iv);
    if (iv.length !== 12) throw new Error();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(name) },
      await encryptionKey(csrf),
      decode(envelope.ciphertext),
    );
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    if (
      value.version !== 1 ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= Date.now() ||
      typeof value.key !== "string" ||
      value.key.length !== 36 ||
      !value.command ||
      !(
        scope === "payments"
          ? ["register", "confirm", "reject", "void", "configure"]
          : ["create", "update", "void"]
      ).includes(value.command.operation)
    )
      throw new Error();
    return { key: value.key, command: value.command as T };
  } catch {
    storage.removeItem(name);
    return null;
  }
}
