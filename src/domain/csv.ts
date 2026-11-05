import { parseMoney, type Currency } from './money.ts';

export const CSV_LIMITS = { bytes: 15 * 1024 * 1024, rows: 2000, columns: 100, cellCharacters: 16384, candidates: 200 } as const;
export type CsvSeparator = ',' | ';' | '\t';
export type CsvCell = {
  /** Coordenadas 1-based del inicio del campo en el archivo; columnIndex es tabular. */
  row: number; column: number; columnIndex: number; text: string; literal: string;
};
export type CsvRow = { row: number; cells: CsvCell[] };
export type CsvTable = { rows: CsvRow[]; separator: CsvSeparator; hadBom: boolean };
export type CsvErrorCode = 'INVALID_OPTIONS' | 'FILE_TOO_LARGE' | 'TOO_MANY_ROWS' | 'TOO_MANY_COLUMNS' | 'CELL_TOO_LARGE' | 'INVALID_CSV' | 'INVALID_HEADER' | 'TOO_MANY_CANDIDATES';
export class CsvError extends Error {
  readonly code: CsvErrorCode;
  readonly row: number | null;
  readonly column: number | null;
  constructor(code: CsvErrorCode, row: number | null = null, column: number | null = null) {
    super('El archivo CSV no cumple el formato o los límites admitidos.');
    this.name = 'CsvError'; this.code = code; this.row = row; this.column = column;
  }
}
/** Parser neutral: no evalúa fórmulas, no interpreta encabezados ni escribe gastos. */
export function parseCsv(input: string, separator: CsvSeparator): CsvTable {
  if (typeof input !== 'string' || ![',', ';', '\t'].includes(separator)) throw new CsvError('INVALID_OPTIONS');
  if (input.length > CSV_LIMITS.bytes || new TextEncoder().encode(input).byteLength > CSV_LIMITS.bytes) throw new CsvError('FILE_TOO_LARGE');
  if (input.includes('\0')) throw new CsvError('INVALID_CSV');
  const hadBom = input.startsWith('\uFEFF');
  const source = hadBom ? input.slice(1) : input;
  if (!source.length) return { rows: [], separator, hadBom };
  const rows: CsvRow[] = [];
  let cells: CsvCell[] = [];
  let row = 1, column = 1, recordRow = 1, fieldRow = 1, fieldColumn = 1, fieldStart = 0;
  let text = '', state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let recordTouched = false;
  function append(value: string) {
    text += value;
    if (text.length > CSV_LIMITS.cellCharacters) throw new CsvError('CELL_TOO_LARGE', fieldRow, fieldColumn);
  }
  function finishCell(end: number) {
    if (cells.length >= CSV_LIMITS.columns) throw new CsvError('TOO_MANY_COLUMNS', fieldRow, fieldColumn);
    cells.push({ row: fieldRow, column: fieldColumn, columnIndex: cells.length + 1, text, literal: source.slice(fieldStart, end) });
    text = ''; state = 'start';
  }
  function finishRow() {
    if (rows.length >= CSV_LIMITS.rows) throw new CsvError('TOO_MANY_ROWS', recordRow, 1);
    rows.push({ row: recordRow, cells }); cells = []; recordTouched = false;
  }
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const newline = char === '\r' || char === '\n';
    const newlineWidth = char === '\r' && source[index + 1] === '\n' ? 2 : 1;
    if (state === 'quoted') {
      recordTouched = true;
      if (char === '"') {
        if (source[index + 1] === '"') { append('"'); index++; column += 2; }
        else { state = 'closed'; column++; }
      } else if (newline) {
        append(source.slice(index, index + newlineWidth)); index += newlineWidth - 1; row++; column = 1;
      } else { append(char); column++; }
      continue;
    }
    if (char === separator) {
      finishCell(index); recordTouched = true; column++;
      fieldStart = index + 1; fieldRow = row; fieldColumn = column;
      continue;
    }
    if (newline) {
      finishCell(index); finishRow(); index += newlineWidth - 1; row++; column = 1;
      recordRow = row; fieldRow = row; fieldColumn = 1; fieldStart = index + 1;
      continue;
    }
    if (state === 'closed') throw new CsvError('INVALID_CSV', row, column);
    if (char === '"') {
      if (state !== 'start') throw new CsvError('INVALID_CSV', row, column);
      state = 'quoted'; recordTouched = true; column++;
    } else { state = 'plain'; recordTouched = true; append(char); column++; }
  }
  if (state === 'quoted') throw new CsvError('INVALID_CSV', fieldRow, fieldColumn);
  if (recordTouched || cells.length || fieldStart < source.length) { finishCell(source.length); finishRow(); }
  return { rows, separator, hadBom };
}

export type CsvHeaderMap = { description: string; date: string; amount: string; currency: string };
export const DEFAULT_CSV_HEADERS: CsvHeaderMap = { description: 'description', date: 'date', amount: 'amount', currency: 'currency' };
export type CandidateWarning = 'REQUIRES_REVIEW' | 'MISSING_DESCRIPTION' | 'INVALID_DATE' | 'INVALID_AMOUNT' | 'UNKNOWN_CURRENCY' | 'FORMULA_LIKE_CONTENT' | 'OUTSIDE_TRIP_DATES';
export type CsvCandidate = {
  sourceRow: number;
  description: string | null;
  date: string | null;
  amountMinor: string | null;
  currency: Currency | null;
  movementType: 'unknown';
  warnings: CandidateWarning[];
  fields: { description: CsvCell; date: CsvCell; amount: CsvCell; currency: CsvCell };
};
export type CsvPreview = {
  schemaVersion: 'csv-preview-v1';
  candidates: CsvCandidate[];
  omittedEmptyRows: number[];
  omittedColumns: number[];
  headerRow: number | null;
};
function isoDate(value: string): string | null {
  if (value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function empty(row: CsvRow) { return row.cells.every(cell => !cell.text.trim()); }
/** Interpretación únicamente con encabezados explícitos. Todos los resultados son candidatos. */
export function csvCandidates(table: CsvTable, headers: CsvHeaderMap = DEFAULT_CSV_HEADERS, tripDates?: { start: string; end: string }): CsvPreview {
  if (!headers || Object.keys(headers).length !== 4 || Object.values(headers).some(value => typeof value !== 'string' || !value.length)
    || new Set(Object.values(headers)).size !== 4) throw new CsvError('INVALID_OPTIONS');
  if (tripDates && (!isoDate(tripDates.start) || !isoDate(tripDates.end) || tripDates.start > tripDates.end)) throw new CsvError('INVALID_OPTIONS');
  const omittedEmptyRows: number[] = [];
  const nonempty = table.rows.filter(row => { if (empty(row)) { omittedEmptyRows.push(row.row); return false; } return true; });
  if (!nonempty.length) return { schemaVersion: 'csv-preview-v1', candidates: [], omittedEmptyRows, omittedColumns: [], headerRow: null };
  const header = nonempty[0];
  const fields = ['description', 'date', 'amount', 'currency'] as const;
  const indexes = {} as Record<typeof fields[number], number>;
  for (const field of fields) {
    const matches = header.cells.flatMap((cell, index) => cell.text === headers[field] ? [index] : []);
    if (matches.length !== 1) throw new CsvError('INVALID_HEADER', header.row, 1);
    indexes[field] = matches[0];
  }
  const rows = nonempty.slice(1);
  if (rows.length > CSV_LIMITS.candidates) throw new CsvError('TOO_MANY_CANDIDATES');
  const candidates = rows.map(row => {
    if (row.cells.length !== header.cells.length) throw new CsvError('INVALID_CSV', row.row, 1);
    const cells = { description: row.cells[indexes.description], date: row.cells[indexes.date], amount: row.cells[indexes.amount], currency: row.cells[indexes.currency] };
    const warnings: CandidateWarning[] = ['REQUIRES_REVIEW'];
    const description = cells.description.text.trim() ? cells.description.text : null;
    if (description === null) warnings.push('MISSING_DESCRIPTION');
    const date = isoDate(cells.date.text);
    if (date === null) warnings.push('INVALID_DATE');
    else if (tripDates && (date < tripDates.start || date > tripDates.end)) warnings.push('OUTSIDE_TRIP_DATES');
    let amountMinor: string | null = null;
    try { amountMinor = parseMoney(cells.amount.text).toString(); } catch { warnings.push('INVALID_AMOUNT'); }
    const currency = cells.currency.text === 'PEN' || cells.currency.text === 'USD' ? cells.currency.text : null;
    if (currency === null) warnings.push('UNKNOWN_CURRENCY');
    // Solo señalización: no ejecutar ni eliminar texto. Incluye columnas no mapeadas.
    if (row.cells.some(cell => /^[\s]*[=+\-@]/.test(cell.text))) warnings.push('FORMULA_LIKE_CONTENT');
    return { sourceRow: row.row, description, date, amountMinor, currency, movementType: 'unknown' as const, warnings, fields: cells };
  });
  return { schemaVersion: 'csv-preview-v1', candidates, omittedEmptyRows, omittedColumns: header.cells.map((_, index) => index).filter(index => !Object.values(indexes).includes(index)).map(index => index + 1), headerRow: header.row };
}
