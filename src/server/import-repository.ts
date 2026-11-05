import { PersistenceError, type SqlExecutor } from "./expense-repository";
import { hashToken } from "./tokens";
import type { ImportCommand, ImportJob, ImportRow } from "./import-contract";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function object(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function failure(e: unknown): never {
  if (e instanceof PersistenceError) throw e;
  const code = object(e) ? e.code : null;
  if (code === "28000") throw new PersistenceError("UNAUTHORIZED");
  if (code === "42501") throw new PersistenceError("FORBIDDEN");
  if (code === "P0001" && object(e) && e.message === "rate_limited")
    throw new PersistenceError("RATE_LIMITED");
  if (
    code === "40001" &&
    object(e) &&
    ["import_version_conflict", "import_expired"].includes(String(e.message))
  )
    throw new PersistenceError("STALE_VERSION");
  if (["40001", "23505", "40P01"].includes(String(code)))
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
    ].includes(String(code))
  )
    throw new PersistenceError("INVALID_INPUT");
  throw new PersistenceError("UNAVAILABLE");
}
function rows(v: unknown): v is ImportRow[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 200) return false;
  const ids = new Set<string>();
  return v.every((r) => {
    if (
      !object(r) ||
      typeof r.id !== "string" ||
      !uuid.test(r.id) ||
      ids.has(r.id.toLowerCase())
    )
      return false;
    ids.add(r.id.toLowerCase());
    return (
      typeof r.description === "string" &&
      r.description.length <= 240 &&
      typeof r.spentOn === "string" &&
      r.spentOn.length <= 10 &&
      typeof r.amountMinor === "string" &&
      r.amountMinor.length <= 20 &&
      ["", "PEN", "USD"].includes(String(r.currency)) &&
      typeof r.payerId === "string" &&
      r.payerId.length <= 36 &&
      Array.isArray(r.splits) &&
      r.splits.length <= 200 &&
      r.splits.every(
        (s) =>
          object(s) &&
          typeof s.participantId === "string" &&
          s.participantId.length <= 36 &&
          typeof s.amountMinor === "string" &&
          s.amountMinor.length <= 20,
      ) &&
      typeof r.selected === "boolean" &&
      typeof r.reviewed === "boolean" &&
      typeof r.keepBoth === "boolean" &&
      typeof r.evidence === "string" &&
      r.evidence.length <= 2000 &&
      Number.isSafeInteger(r.sourceRow) &&
      Number(r.sourceRow) > 0 &&
      Number(r.sourceRow) <= 9999999 &&
      Array.isArray(r.warnings) &&
      r.warnings.length <= 10 &&
      r.warnings.every((w) => typeof w === "string" && w.length <= 80) &&
      Array.isArray(r.duplicateExpenseIds) &&
      r.duplicateExpenseIds.length <= 10000 &&
      r.duplicateExpenseIds.every(
        (d) => typeof d === "string" && uuid.test(d),
      ) &&
      (r.sourceSheet === undefined ||
        (typeof r.sourceSheet === "string" && r.sourceSheet.length <= 120))
    );
  });
}
export function validateImportCommand(v: unknown): ImportCommand {
  if (
    !object(v) ||
    Object.keys(v).some(
      (k) =>
        !["operation", "sourceType", "rows", "id", "expectedVersion"].includes(
          k,
        ),
    )
  )
    throw new PersistenceError("INVALID_INPUT");
  if (v.operation === "create") {
    if (
      !["manual", "csv", "excel"].includes(String(v.sourceType)) ||
      !rows(v.rows) ||
      "id" in v ||
      "expectedVersion" in v
    )
      throw new PersistenceError("INVALID_INPUT");
  } else if (["save", "confirm", "cancel"].includes(String(v.operation))) {
    if (
      typeof v.id !== "string" ||
      !uuid.test(v.id) ||
      !Number.isSafeInteger(v.expectedVersion) ||
      Number(v.expectedVersion) < 1 ||
      Number(v.expectedVersion) > 2147483646 ||
      "sourceType" in v
    )
      throw new PersistenceError("INVALID_INPUT");
    if (v.operation === "save" ? !rows(v.rows) : "rows" in v)
      throw new PersistenceError("INVALID_INPUT");
  } else throw new PersistenceError("INVALID_INPUT");
  return v as ImportCommand;
}
function job(v: unknown): ImportJob {
  if (
    !object(v) ||
    typeof v.id !== "string" ||
    !uuid.test(v.id) ||
    !Number.isSafeInteger(v.version) ||
    Number(v.version) < 1 ||
    !["preview", "persisted", "cancelled", "expired"].includes(
      String(v.state),
    ) ||
    !["manual", "csv", "excel"].includes(String(v.sourceType)) ||
    typeof v.createdAt !== "string" ||
    typeof v.expiresAt !== "string" ||
    !Array.isArray(v.rows) ||
    v.rows.length > 200 ||
    !Array.isArray(v.results) ||
    v.results.length > 200
  )
    throw new PersistenceError("UNAVAILABLE");
  if (
    (v.rows.length > 0 && !rows(v.rows)) ||
    !Number.isFinite(Date.parse(v.createdAt)) ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    v.results.some(
      (r) =>
        !object(r) ||
        typeof r.rowId !== "string" ||
        !uuid.test(r.rowId) ||
        (r.status === "persisted"
          ? typeof r.expenseId !== "string" || !uuid.test(r.expenseId)
          : r.status !== "failed" ||
            !["INVALID_ROW", "FORBIDDEN", "CONFLICT"].includes(String(r.code))),
    )
  )
    throw new PersistenceError("UNAVAILABLE");
  return {
    id: v.id,
    version: Number(v.version),
    state: v.state as ImportJob["state"],
    sourceType: v.sourceType as ImportJob["sourceType"],
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    tripDates:
      v.tripDates === null || v.tripDates === undefined
        ? null
        : object(v.tripDates) &&
            typeof v.tripDates.start === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(v.tripDates.start) &&
            Number.isFinite(Date.parse(v.tripDates.start + "T00:00:00Z")) &&
            typeof v.tripDates.end === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(v.tripDates.end) &&
            Number.isFinite(Date.parse(v.tripDates.end + "T00:00:00Z"))
          ? { start: v.tripDates.start, end: v.tripDates.end }
          : null,
    rows: v.rows as ImportRow[],
    results: v.results as ImportJob["results"],
  };
}
export class ImportRepository {
  constructor(private readonly database: SqlExecutor) {}
  async list(
    session: string,
    id?: string,
  ): Promise<{ jobs: ImportJob[] } | { job: ImportJob }> {
    try {
      if (id !== undefined && !uuid.test(id))
        throw new PersistenceError("INVALID_INPUT");
      const r = await this.database.query(
        "select app_api.list_imports($1::text,$2::uuid) as result",
        [hashToken(session), id ?? null],
      );
      const v = r.rows[0]?.result;
      if (!object(v)) throw new PersistenceError("UNAVAILABLE");
      if (id !== undefined) return { job: job(v.job) };
      if (!Array.isArray(v.jobs) || v.jobs.length > 50)
        throw new PersistenceError("UNAVAILABLE");
      return { jobs: v.jobs.map(job) };
    } catch (e) {
      return failure(e);
    }
  }
  async mutate(
    session: string,
    key: string,
    command: unknown,
  ): Promise<{ job: ImportJob }> {
    try {
      if (!uuid.test(key)) throw new PersistenceError("INVALID_INPUT");
      const input = validateImportCommand(command);
      const r = await this.database.query(
        "select app_api.mutate_import($1::text,$2::uuid,$3::jsonb) as result",
        [hashToken(session), key, JSON.stringify(input)],
      );
      const v = r.rows[0]?.result;
      if (!object(v)) throw new PersistenceError("UNAVAILABLE");
      return { job: job(v.job) };
    } catch (e) {
      return failure(e);
    }
  }
}
