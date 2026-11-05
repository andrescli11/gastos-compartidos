import { calculateBalances, validateCustomSplit, type Currency, type Expense, type Split } from './money.ts';
export type ExchangeRate = { numerator: bigint; denominator: bigint };
export function parseExchangeRate(value: string): ExchangeRate {
  if (value !== value.trim() || !/^\d{1,8}([.,]\d{1,8})?$/.test(value)) throw new Error('Tipo de cambio inválido.');
  const [whole, decimals = ''] = value.replace(',', '.').split('.');
  const numerator = BigInt(whole + decimals);
  if (numerator <= 0n) throw new Error('El tipo de cambio debe ser positivo.');
  return { numerator, denominator: 10n ** BigInt(decimals.length) };
}
export function convertExpense(expense: Expense, rate: ExchangeRate): Expense | null {
  validateCustomSplit(expense.amountMinor, expense.splits);
  if (!expense.payerId.trim() || !['PEN', 'USD'].includes(expense.currency)) throw new Error('Gasto inválido.');
  if (rate.numerator <= 0n || rate.denominator <= 0n) throw new Error('Tipo de cambio inválido.');
  if (expense.currency === 'PEN') return { ...expense, splits: expense.splits.map(s => ({ ...s })) };
  const product = expense.amountMinor * rate.numerator;
  const total = (2n * product + rate.denominator) / (2n * rate.denominator);
  if (total === 0n) return null;
  const ranked = expense.splits.map(split => ({ ...split, amountMinor: total * split.amountMinor / expense.amountMinor, remainder: total * split.amountMinor % expense.amountMinor })).sort((a,b) => a.remainder === b.remainder ? compareId(a.participantId,b.participantId) : a.remainder > b.remainder ? -1 : 1);
  let remaining = total - ranked.reduce((sum,s) => sum + s.amountMinor,0n);
  for (const split of ranked) { if (remaining === 0n) break; split.amountMinor += 1n; remaining -= 1n; }
  const splits: Split[] = ranked.filter(s => s.amountMinor > 0n).map(({participantId,amountMinor}) => ({participantId,amountMinor})).sort((a,b) => compareId(a.participantId,b.participantId));
  return { ...expense, currency: 'PEN', amountMinor: total, splits };
}
function compareId(a: string,b: string) { return a < b ? -1 : a > b ? 1 : 0; }
export function consolidatedBalances(expenses: readonly Expense[], rate: ExchangeRate) {
  if (rate.numerator <= 0n || rate.denominator <= 0n) throw new Error('Tipo de cambio inválido.');
  return calculateBalances(expenses.map(e => convertExpense(e,rate)).filter((e): e is Expense => e !== null)).PEN;
}
export type Transfer = { senderId: string; receiverId: string; amountMinor: bigint; currency: Currency };
export type SettlementPlan = { transfers: Transfer[]; minimumProven: boolean };
/** Máximo número de grupos disjuntos de suma cero: mínimo = n - grupos.
 * DP O(n*2^n), memoria O(2^n). Los números solo indexan máscaras y cuentan grupos.
 */
export function planSettlement(balances: ReadonlyMap<string,bigint>, currency: Currency): SettlementPlan {
  if (!['PEN','USD'].includes(currency) || [...balances.keys()].some(id => !id.trim())) throw new Error('Libro inválido.');
  const entries = [...balances].filter(([,amount]) => amount !== 0n).sort(([a],[b]) => compareId(a,b));
  if (entries.reduce((sum,[,amount]) => sum + amount,0n) !== 0n) throw new Error('Los balances deben sumar cero.');
  if (!entries.length) return { transfers: [], minimumProven: true };
  const groups: typeof entries[] = [];
  if (entries.length <= 18) {
    const size = 1 << entries.length;
    const sums: bigint[] = new Array(size).fill(0n);
    const best = new Uint8Array(size);
    const previous = new Uint8Array(size);
    for (let mask = 1; mask < size; mask++) {
      const low = mask & -mask;
      const index = 31 - Math.clz32(low);
      sums[mask] = sums[mask ^ low] + entries[index][1];
      let score = -1;
      for (let bits = mask; bits; bits &= bits - 1) {
        const bit = bits & -bits;
        const candidate = best[mask ^ bit];
        if (candidate > score) { score = candidate; previous[mask] = 31 - Math.clz32(bit); }
      }
      best[mask] = score + (sums[mask] === 0n ? 1 : 0);
    }
    let mask = size - 1;
    let group: typeof entries = [];
    let sum = 0n;
    while (mask) {
      const index = previous[mask];
      group.push(entries[index]); sum += entries[index][1]; mask ^= 1 << index;
      if (sum === 0n) { groups.push(group); group = []; }
    }
  } else groups.push(entries);
  const transfers: Transfer[] = [];
  for (const group of groups) {
    const debtors = group.filter(([,n]) => n < 0n).map(([id,n]) => ({id,amount: -n})).sort((a,b) => compareId(a.id,b.id));
    const creditors = group.filter(([,n]) => n > 0n).map(([id,n]) => ({id,amount:n})).sort((a,b) => compareId(a.id,b.id));
    let d = 0, c = 0;
    while (d < debtors.length && c < creditors.length) {
      const amount = debtors[d].amount < creditors[c].amount ? debtors[d].amount : creditors[c].amount;
      transfers.push({ senderId: debtors[d].id, receiverId: creditors[c].id, amountMinor: amount, currency });
      debtors[d].amount -= amount; creditors[c].amount -= amount;
      if (debtors[d].amount === 0n) d++;
      if (creditors[c].amount === 0n) c++;
    }
  }
  return { transfers, minimumProven: entries.length <= 18 };
}
