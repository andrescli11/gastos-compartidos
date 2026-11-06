export type ImportSourceType = "manual" | "csv" | "excel";
export type ImportRow = {
  id: string;
  description: string;
  spentOn: string;
  amountMinor: string;
  currency: "PEN" | "USD" | "";
  payerId: string;
  splits: { participantId: string; amountMinor: string }[];
  selected: boolean;
  reviewed: boolean;
  keepBoth: boolean;
  evidence: string;
  sourceRow: number;
  sourceSheet?: string;
  warnings: string[];
  duplicateExpenseIds: string[];
};
export type ImportResult = {
  rowId: string;
  status: "persisted" | "failed";
  expenseId?: string;
  code?: "INVALID_ROW" | "FORBIDDEN" | "CONFLICT";
};
export type ImportJob = {
  id: string;
  version: number;
  state: "preview" | "persisted" | "cancelled" | "expired";
  sourceType: ImportSourceType;
  createdAt: string;
  expiresAt: string;
  tripDates?: { start: string; end: string } | null;
  rows: ImportRow[];
  results: ImportResult[];
};
export type ImportCommand =
  | { operation: "create"; sourceType: ImportSourceType; rows: ImportRow[] }
  | {
      operation: "save";
      id: string;
      expectedVersion: number;
      rows: ImportRow[];
    }
  | { operation: "confirm" | "cancel"; id: string; expectedVersion: number };
