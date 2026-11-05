import type { Currency } from "./money.ts";
import { convertExpense, planSettlement } from "./settlement.ts";
import { paymentBalances, type PaymentLedger } from "./payments.ts";
import type { CurrencySummary } from "./summary.ts";
/** Contrato JSON para futura API de cierre. No devuelve bigint ni mezcla libros. */
export function summarizePaymentLedger(ledger: PaymentLedger) {
  const books = paymentBalances(ledger);
  const originalExpenseTotals = { PEN: 0n, USD: 0n };
  const settlementTotals = { PEN: 0n, USD: 0n };
  for (const expense of ledger.expenses) {
    originalExpenseTotals[expense.currency] += expense.amountMinor;
    const settled =
      ledger.configuration.mode === "separate"
        ? expense
        : convertExpense(expense, ledger.configuration.rate);
    if (settled) settlementTotals[settled.currency] += settled.amountMinor;
  }
  const describe = (currency: Currency): CurrencySummary => {
    const plan = planSettlement(books[currency], currency);
    return {
      totalMinor: settlementTotals[currency].toString(),
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
  const pendingCount = ledger.payments.filter(
    (p) => p.state === "pending",
  ).length;
  const confirmedCount = ledger.payments.filter(
    (p) => p.state === "confirmed",
  ).length;
  return {
    ledgerVersion: ledger.version,
    configurationChosen: ledger.configurationChosenBy !== null,
    configuration:
      ledger.configuration.mode === "separate"
        ? { mode: "separate" as const }
        : {
            mode: "consolidated" as const,
            rate: {
              numerator: ledger.configuration.rate.numerator.toString(),
              denominator: ledger.configuration.rate.denominator.toString(),
            },
          },
    originalExpenseTotals: {
      PEN: originalExpenseTotals.PEN.toString(),
      USD: originalExpenseTotals.USD.toString(),
    },
    pendingCount,
    confirmedCount,
    configurationLocked: pendingCount > 0 || confirmedCount > 0,
    closed:
      pendingCount === 0 &&
      Object.values(books).every((book) =>
        [...book.values()].every((value) => value === 0n),
      ),
    books: { PEN: describe("PEN"), USD: describe("USD") },
  };
}
