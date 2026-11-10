import { PersistenceError, type SqlExecutor } from "./expense-repository.ts";
import { hashToken } from "./tokens.ts";
import { validPinVerifier } from "./pin-crypto.ts";
export type PinUser = {
  id: string;
  displayName: string;
  role: "participant" | "admin";
};
export type ManagedPinUser = PinUser & {
  version: number;
  pinEnabled: boolean;
  hasPin: boolean;
  own: boolean;
};
export type PinCredential = {
  verifier: string;
  version: number;
  linkVersion: number;
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const pinUserId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const version = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < 2147483647;
function failure(e: unknown): never {
  if (e instanceof PersistenceError) throw e;
  const code = object(e) ? e.code : undefined;
  if (code === "28000") throw new PersistenceError("UNAUTHORIZED");
  if (code === "42501") throw new PersistenceError("FORBIDDEN");
  if (code === "40001" && object(e) && e.message === "pin_version_conflict")
    throw new PersistenceError("STALE_VERSION");
  if (["40001", "23505", "40P01"].includes(String(code)))
    throw new PersistenceError("CONFLICT");
  if (["22023", "22P02", "23514", "23503"].includes(String(code)))
    throw new PersistenceError("INVALID_INPUT");
  throw new PersistenceError("UNAVAILABLE");
}
function users(value: unknown, managed: false): PinUser[];
function users(value: unknown, managed: true): ManagedPinUser[];
function users(value: unknown, managed: boolean): PinUser[] | ManagedPinUser[] {
  if (!Array.isArray(value)) throw new PersistenceError("UNAVAILABLE");
  const ids = new Set<string>();
  return value.map((v) => {
    if (
      !object(v) ||
      !pinUserId(v.id) ||
      ids.has(v.id.toLowerCase()) ||
      typeof v.displayName !== "string" ||
      !v.displayName.trim() ||
      v.displayName.length > 100 ||
      !["admin", "participant"].includes(String(v.role))
    )
      throw new PersistenceError("UNAVAILABLE");
    ids.add(v.id.toLowerCase());
    const basic: PinUser = {
      id: v.id,
      displayName: v.displayName,
      role: v.role as PinUser["role"],
    };
    if (!managed) return basic;
    if (
      !version(v.version) ||
      typeof v.pinEnabled !== "boolean" ||
      typeof v.hasPin !== "boolean" ||
      typeof v.own !== "boolean" ||
      (v.pinEnabled && !v.hasPin)
    )
      throw new PersistenceError("UNAVAILABLE");
    return {
      ...basic,
      version: v.version,
      pinEnabled: v.pinEnabled,
      hasPin: v.hasPin,
      own: v.own,
    };
  });
}
export class PinRepository {
  private database: SqlExecutor;
  constructor(database: SqlExecutor) {
    this.database = database;
  }
  async users(): Promise<PinUser[]> {
    try {
      return users(
        (await this.database.query("select app_api.pin_users() as result", []))
          .rows[0]?.result,
        false,
      );
    } catch (e) {
      return failure(e);
    }
  }
  async credential(id: string): Promise<PinCredential | null> {
    try {
      if (!pinUserId(id)) throw new PersistenceError("INVALID_INPUT");
      const value = (
        await this.database.query(
          "select app_api.pin_verifier($1::uuid) as result",
          [id],
        )
      ).rows[0]?.result;
      if (value === null) return null;
      if (
        !object(value) ||
        !validPinVerifier(value.verifier) ||
        !version(value.version) ||
        !value.version ||
        !version(value.linkVersion) ||
        !value.linkVersion
      )
        throw new PersistenceError("UNAVAILABLE");
      return {
        verifier: value.verifier,
        version: value.version,
        linkVersion: value.linkVersion,
      };
    } catch (e) {
      return failure(e);
    }
  }
  async exchange(id: string, credential: PinCredential, session: string) {
    try {
      const value = (
        await this.database.query(
          "select app_api.exchange_pin($1::uuid,$2::integer,$3::integer,$4::text,$5::text) as result",
          [
            id,
            credential.version,
            credential.linkVersion,
            credential.verifier,
            hashToken(session),
          ],
        )
      ).rows[0]?.result;
      if (
        !object(value) ||
        typeof value.expiresAt !== "string" ||
        !Number.isFinite(Date.parse(value.expiresAt))
      )
        throw new PersistenceError("UNAVAILABLE");
      return { expiresAt: value.expiresAt };
    } catch (e) {
      return failure(e);
    }
  }
  async managedUsers(session: string) {
    try {
      return users(
        (
          await this.database.query(
            "select app_api.list_pin_users($1::text) as result",
            [hashToken(session)],
          )
        ).rows[0]?.result,
        true,
      );
    } catch (e) {
      return failure(e);
    }
  }
  async manage(
    session: string,
    key: string,
    command: {
      operation: "set" | "disable";
      id: string;
      expectedVersion: number;
      verifier: string | null;
    },
  ) {
    try {
      if (
        !pinUserId(key) ||
        !pinUserId(command.id) ||
        !version(command.expectedVersion) ||
        (command.operation === "set"
          ? !validPinVerifier(command.verifier)
          : command.verifier !== null)
      )
        throw new PersistenceError("INVALID_INPUT");
      const value = (
        await this.database.query(
          "select app_api.manage_pin($1::text,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as result",
          [
            hashToken(session),
            key,
            command.id,
            command.expectedVersion,
            command.operation,
            command.verifier,
          ],
        )
      ).rows[0]?.result;
      if (
        !object(value) ||
        value.ok !== true ||
        typeof value.ownSessionRevoked !== "boolean"
      )
        throw new PersistenceError("UNAVAILABLE");
      return { ok: true, ownSessionRevoked: value.ownSessionRevoked };
    } catch (e) {
      return failure(e);
    }
  }
}
