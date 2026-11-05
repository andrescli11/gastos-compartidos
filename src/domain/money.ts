export type Currency = 'PEN' | 'USD';
export type Split = { participantId: string; amountMinor: bigint };

/** Decimal humano sin separadores de miles. Nunca pasa por Number. */
export function parseMoney(value: string): bigint {
  if (value !== value.trim() || !/^\d{1,12}([.,]\d{1,2})?$/.test(value))
    throw new Error('Introduce un importe positivo con hasta dos decimales, sin miles.');
  const [whole, decimals = ''] = value.replace(',', '.').split('.');
  const amount = BigInt(whole) * 100n + BigInt(decimals.padEnd(2, '0'));
  if (amount <= 0n) throw new Error('El importe debe ser mayor que cero.');
  return amount;
}

export function formatMoney(amount: bigint, currency: Currency): string {
  const absolute = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}${currency === 'PEN' ? 'S/' : 'US$'} ${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function validateParticipants(ids: readonly string[]) {
  if (!ids.length || ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length)
    throw new Error('Selecciona beneficiarios únicos y válidos.');
}

export function equalSplit(amount: bigint, ids: readonly string[]): Split[] {
  validateParticipants(ids);
  const count = BigInt(ids.length);
  if (amount < count) throw new Error('Cada beneficiario debe recibir al menos un céntimo.');
  const remainder = amount % count;
  return [...ids].sort().map((participantId, index) => ({
    participantId,
    amountMinor: amount / count + (BigInt(index) < remainder ? 1n : 0n),
  }));
}

export function validateCustomSplit(amount: bigint, splits: readonly Split[]): Split[] {
  validateParticipants(splits.map((split) => split.participantId));
  if (amount <= 0n || splits.some((split) => split.amountMinor <= 0n))
    throw new Error('Todas las partes deben ser positivas.');
  if (splits.reduce((sum, split) => sum + split.amountMinor, 0n) !== amount)
    throw new Error('Las partes deben sumar exactamente el total.');
  return splits.map((split) => ({ ...split })).sort((a, b) => a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);
}

export type Expense = { payerId: string; currency: Currency; amountMinor: bigint; splits: readonly Split[] };
export function calculateBalances(expenses: readonly Expense[]) {
  const books: Record<Currency, Map<string, bigint>> = { PEN: new Map(), USD: new Map() };
  for (const expense of expenses) {
    if (!expense.payerId.trim() || !['PEN', 'USD'].includes(expense.currency)) throw new Error('Gasto inválido.');
    validateCustomSplit(expense.amountMinor, expense.splits);
    const book = books[expense.currency];
    book.set(expense.payerId, (book.get(expense.payerId) ?? 0n) + expense.amountMinor);
    for (const split of expense.splits) book.set(split.participantId, (book.get(split.participantId) ?? 0n) - split.amountMinor);
  }
  return books;
}
