// Verificación de emergencia sin dependencias. Vitest sigue siendo el gate de CI.
import assert from 'node:assert/strict';
import { parseMoney, equalSplit, validateCustomSplit, calculateBalances, formatMoney } from '../src/domain/money.ts';
for (const invalid of ['0', '-1', '1.001', '1e3', '', '1\n', '1.23\r\n', ' 2', '1,000.00']) assert.throws(() => parseMoney(invalid));
assert.equal(parseMoney('999999999999.99'), 99999999999999n);
assert.equal(parseMoney('0,01'), 1n);
assert.equal(formatMoney(-101n, 'USD'), '-US$ 1.01');
assert.throws(() => equalSplit(1n, ['a', 'b']));
assert.throws(() => equalSplit(100n, ['a', 'a']));
assert.throws(() => validateCustomSplit(10n, [{ participantId: 'a', amountMinor: 9n }]));
for (let count = 1; count <= 18; count++) {
  const ids = Array.from({ length: count }, (_, i) => `p-${i}`);
  for (let iteration = 0; iteration < 100; iteration++) {
    const amount = BigInt(count) + BigInt(iteration) * 101010101n;
    const splits = equalSplit(amount, ids);
    assert.equal(splits.reduce((sum, split) => sum + split.amountMinor, 0n), amount);
    assert.ok(splits.every(split => split.amountMinor > 0n));
    assert.deepEqual(splits, equalSplit(amount, [...ids].reverse()));
    const expenses = ['PEN', 'USD'].map(currency => ({ payerId: 'outside', amountMinor: amount, currency, splits }));
    const books = calculateBalances(expenses);
    assert.deepEqual(books, calculateBalances([...expenses].reverse()));
    for (const currency of ['PEN', 'USD']) assert.equal([...books[currency].values()].reduce((sum, value) => sum + value, 0n), 0n);
  }
}
console.log('OK: 1800 escenarios de reparto y balance; parser estricto y casos límite.');
