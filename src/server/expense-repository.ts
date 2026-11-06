import { createHash } from "node:crypto";
if (typeof window !== "undefined")
  throw new Error("Módulo exclusivo del servidor.");

export type ExpenseSplitRecord = { participantId: string; amountMinor: string };
export type ExpenseRecord = {
  id: string;
  payerId: string;
  description: string;
  spentOn: string;
  amountMinor: string;
  currency: "PEN" | "USD";
  source: "manual" | "bulk" | "csv" | "excel" | "image";
  state: "active" | "voided";
  version: number;
  splits: ExpenseSplitRecord[];
};
type ExpenseFields = Pick<
  ExpenseRecord,
  "payerId" | "description" | "spentOn" | "amountMinor" | "currency" | "splits"
>;
export type ExpenseCommand =
  | ({ operation: "create" } & ExpenseFields)
  | ({
      operation: "update";
      id: string;
      expectedVersion: number;
    } & ExpenseFields)
  | { operation: "void"; id: string; expectedVersion: number };
/** Compatible con un pool PostgreSQL. El BFF usa un login dedicado miembro de cusco_bff.
 * El adaptador no abre conexiones ni usa claves de servicio de Supabase.
 */
export interface SqlExecutor {
  query(
    text: string,
    values: readonly unknown[],
  ): Promise<{ rows: { result: unknown }[] }>;
}
type PersistenceCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "CONFLICT"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "STALE_VERSION";
export class PersistenceError extends Error {
  readonly code: PersistenceCode;
  constructor(code: PersistenceCode) {
    super(
      {
        INVALID_INPUT: "Revisa los datos de la operación.",
        UNAUTHORIZED: "El enlace o la sesión ya no es válido.",
        FORBIDDEN: "No puedes realizar esta acción.",
        CONFLICT:
          "Los datos cambiaron o la operación entra en conflicto. Recarga antes de continuar.",
        UNAVAILABLE: "No se pudo completar la operación.",
        RATE_LIMITED: "Demasiadas solicitudes. Inténtalo en un minuto.",
        STALE_VERSION:
          "Los datos cambiaron. Actualiza el libro y revisa la operación.",
      }[code],
    );
    this.name = "PersistenceError";
    this.code = code;
  }
}
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    uuidPattern.test(value)
  );
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function minor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    /^[1-9][0-9]{0,13}$/.test(value)
  );
}
function version(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 2147483647
  );
}
function realDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value < "2000-01-01" ||
    value > "2100-12-31"
  )
    return false;
  const date = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function validFields(value: Record<string, unknown>): boolean {
  if (
    !isUuid(value.payerId) ||
    typeof value.description !== "string" ||
    !value.description.trim() ||
    value.description.length > 240 ||
    !realDate(value.spentOn) ||
    !minor(value.amountMinor) ||
    !["PEN", "USD"].includes(value.currency as string) ||
    !Array.isArray(value.splits) ||
    !value.splits.length ||
    value.splits.length > 200
  )
    return false;
  const ids = new Set<string>();
  let total = 0n;
  for (const split of value.splits) {
    if (
      !object(split) ||
      Object.keys(split).some(
        (k) => !["participantId", "amountMinor"].includes(k),
      ) ||
      !isUuid(split.participantId) ||
      !minor(split.amountMinor)
    )
      return false;
    const id = split.participantId.toLowerCase();
    if (ids.has(id)) return false;
    ids.add(id);
    total += BigInt(split.amountMinor);
  }
  return total === BigInt(value.amountMinor);
}
export function validateExpenseCommand(
  value: unknown,
): asserts value is ExpenseCommand {
  if (
    !object(value) ||
    !["create", "update", "void"].includes(value.operation as string)
  )
    throw new PersistenceError("INVALID_INPUT");
  const fields = [
    "payerId",
    "description",
    "spentOn",
    "amountMinor",
    "currency",
    "splits",
  ];
  const allowed =
    value.operation === "create"
      ? ["operation", ...fields]
      : value.operation === "update"
        ? ["operation", "id", "expectedVersion", ...fields]
        : ["operation", "id", "expectedVersion"];
  if (
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    (value.operation !== "create" &&
      (!isUuid(value.id) || !version(value.expectedVersion))) ||
    (value.operation !== "void" && !validFields(value))
  )
    throw new PersistenceError("INVALID_INPUT");
}
function sessionHash(token: string) {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, "base64url").length !== 32 ||
    Buffer.from(token, "base64url").toString("base64url") !== token
  )
    throw new PersistenceError("UNAUTHORIZED");
  return createHash("sha256").update(token, "utf8").digest("hex");
}
function record(value: unknown): ExpenseRecord {
  if (
    !object(value) ||
    !isUuid(value.id) ||
    !version(value.version) ||
    !["active", "voided"].includes(value.state as string) ||
    !["manual", "bulk", "csv", "excel", "image"].includes(
      value.source as string,
    ) ||
    !validFields(value)
  )
    throw new PersistenceError("UNAVAILABLE");
  // Contrato JSON: importes como strings; jamás convertir bigint a Number.
  const clean = value as ExpenseRecord;
  return {
    id: clean.id,
    payerId: clean.payerId,
    description: clean.description,
    spentOn: clean.spentOn,
    amountMinor: clean.amountMinor,
    currency: clean.currency,
    source: clean.source,
    state: clean.state,
    version: clean.version,
    splits: clean.splits.map((s) => ({
      participantId: s.participantId,
      amountMinor: s.amountMinor,
    })),
  };
}
function safeFailure(error: unknown): never {
  if (error instanceof PersistenceError) throw error;
  const code =
    object(error) && typeof error.code === "string" ? error.code : "";
  if (code === "28000") throw new PersistenceError("UNAUTHORIZED");
  if (code === "42501") throw new PersistenceError("FORBIDDEN");
  if (
    code === "40001" &&
    object(error) &&
    error.message === "expense_version_conflict"
  )
    throw new PersistenceError("STALE_VERSION");
  if (["23505", "40001", "40P01"].includes(code))
    throw new PersistenceError("CONFLICT");
  if (
    [
      "22023",
      "22P02",
      "22007",
      "22008",
      "23514",
      "23502",
      "23503",
      "22003",
    ].includes(code)
  )
    throw new PersistenceError("INVALID_INPUT");
  // No conservar cause, SQL, payload, detail ni mensaje del driver.
  throw new PersistenceError("UNAVAILABLE");
}
export class ExpenseRepository {
  private readonly database: SqlExecutor;
  constructor(database: SqlExecutor) {
    this.database = database;
  }
  async mutate(
    sessionToken: string,
    key: string,
    command: ExpenseCommand,
  ): Promise<ExpenseRecord> {
    try {
      const hash = sessionHash(sessionToken);
      if (!isUuid(key)) throw new PersistenceError("INVALID_INPUT");
      validateExpenseCommand(command);
      const result = await this.database.query(
        "select app_api.mutate_expense($1::text,$2::uuid,$3::jsonb) as result",
        [hash, key, JSON.stringify(command)],
      );
      return record(result.rows[0]?.result);
    } catch (error) {
      return safeFailure(error);
    }
  }
  async list(sessionToken: string): Promise<ExpenseRecord[]> {
    try {
      const result = await this.database.query(
        "select app_api.list_expenses($1::text) as result",
        [sessionHash(sessionToken)],
      );
      const values = result.rows[0]?.result;
      if (!Array.isArray(values)) throw new PersistenceError("UNAVAILABLE");
      return values.map(record);
    } catch (error) {
      return safeFailure(error);
    }
  }
}

export { record as parseExpenseRecord };
