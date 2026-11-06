import { calculateBalances, type Currency, type Expense } from "./money.ts";
import { planSettlement } from "./settlement.ts";
export type CurrencySummary = {
  totalMinor: string;
  balances: { participantId: string; amountMinor: string }[];
  transfers: {
    senderId: string;
    receiverId: string;
    amountMinor: string;
    currency: Currency;
  }[];
  minimumProven: boolean;
};
export function summarizeExpenses(
  expenses: readonly Expense[],
): Record<Currency, CurrencySummary> {
  const books = calculateBalances(expenses);
  const summarize = (currency: Currency): CurrencySummary => {
    const plan = planSettlement(books[currency], currency);
    return {
      totalMinor: expenses
        .filter((e) => e.currency === currency)
        .reduce((sum, e) => sum + e.amountMinor, 0n)
        .toString(),
      balances: [...books[currency]]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([participantId, amountMinor]) => ({
          participantId,
          amountMinor: amountMinor.toString(),
        })),
      transfers: plan.transfers.map((t) => ({
        ...t,
        amountMinor: t.amountMinor.toString(),
      })),
      minimumProven: plan.minimumProven,
    };
  };
  return { PEN: summarize("PEN"), USD: summarize("USD") };
}
