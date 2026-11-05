import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { calculateBalances, equalSplit, formatMoney, parseMoney, validateCustomSplit } from './money';
describe('Dinero exacto', () => {
  it('interpreta decimales y coma sin flotantes', () => {
    expect(parseMoney('999999999999.99')).toBe(99999999999999n);
    expect(parseMoney('0,01')).toBe(1n);
    expect(formatMoney(-101n, 'USD')).toBe('-US$ 1.01');
  });
  it.each(['0', '-1', '1.001', '1e3', 'Infinity', '1,000.00', '', ' 2', '1\n', '1.23\r\n', '1000000000000'])('rechaza %s', value => expect(() => parseMoney(value)).toThrow());
  it('distribuye céntimos por ID independientemente del orden', () => {
    expect(equalSplit(100n, ['c', 'a', 'b'])).toEqual([{ participantId: 'a', amountMinor: 34n }, { participantId: 'b', amountMinor: 33n }, { participantId: 'c', amountMinor: 33n }]);
    expect(() => equalSplit(1n, ['a', 'b'])).toThrow();
    expect(() => equalSplit(100n, ['a', 'a'])).toThrow();
    expect(() => equalSplit(100n, [])).toThrow();
  });
  it('valida repartos personalizados', () => {
    expect(() => validateCustomSplit(10n, [{ participantId: 'a', amountMinor: 9n }])).toThrow();
    expect(() => validateCustomSplit(10n, [{ participantId: 'a', amountMinor: 10n }, { participantId: 'b', amountMinor: 0n }])).toThrow();
    expect(validateCustomSplit(10n, [{ participantId: 'a', amountMinor: 10n }])).toHaveLength(1);
  });
  it('conserva el total y produce partes positivas para cualquier reparto', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 18 }), fc.bigInt({ min: 18n, max: 99999999999999n }), (count, amount) => {
      const ids = Array.from({ length: count }, (_, i) => `p-${i}`);
      const splits = equalSplit(amount, ids);
      expect(splits.reduce((sum, s) => sum + s.amountMinor, 0n)).toBe(amount);
      expect(splits.every(s => s.amountMinor > 0n)).toBe(true);
      expect(equalSplit(amount, ids.reverse())).toEqual(splits);
      const books = calculateBalances([{ payerId: 'payer-outside', amountMinor: amount, currency: 'PEN', splits }]);
      expect([...books.PEN.values()].reduce((sum, n) => sum + n, 0n)).toBe(0n);
      expect(books.USD.size).toBe(0);
    }), { numRuns: 500 });
  });
  it('separa monedas y mantiene el balance ante permutaciones', () => {
    const expenses = [{ payerId: 'a', amountMinor: 100n, currency: 'PEN' as const, splits: equalSplit(100n, ['a', 'b']) }, { payerId: 'b', amountMinor: 300n, currency: 'USD' as const, splits: equalSplit(300n, ['a', 'b']) }];
    expect(calculateBalances(expenses)).toEqual(calculateBalances([...expenses].reverse()));
    expect(calculateBalances(expenses).PEN.get('a')).toBe(50n);
    expect(calculateBalances(expenses).USD.get('a')).toBe(-150n);
  });
});
