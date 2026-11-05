import assert from 'node:assert/strict';
import { convertExpense, parseExchangeRate, planSettlement, consolidatedBalances } from '../src/domain/settlement.ts';
import { equalSplit } from '../src/domain/money.ts';
function verify(values) {
  const book = new Map(values.map((n,i) => [`p-${i}`,BigInt(n)]));
  const plan = planSettlement(book,'PEN');
  const remaining = new Map(book);
  for (const t of plan.transfers) {
    assert.ok(t.amountMinor > 0n);
    assert.notEqual(t.senderId,t.receiverId);
    assert.equal(t.currency,'PEN');
    remaining.set(t.senderId,remaining.get(t.senderId)+t.amountMinor);
    remaining.set(t.receiverId,remaining.get(t.receiverId)-t.amountMinor);
  }
  assert.ok([...remaining.values()].every(n => n === 0n));
  assert.deepEqual(plan,planSettlement(new Map([...book].reverse()),'PEN'));
  assert.ok(plan.transfers.length <= Math.max(0,values.filter(n => n !== 0).length-1));
  return plan;
}
// Oráculo independiente: búsqueda exhaustiva de cancelaciones por deuda.
function minimum(values) {
  const debts = values.filter(n => n !== 0);
  function solve(start) {
    while (start < debts.length && debts[start] === 0) start++;
    if (start === debts.length) return 0;
    let best = Infinity;
    for (let j=start+1;j<debts.length;j++) {
      if (debts[start]*debts[j] >= 0) continue;
      const old = debts[j]; debts[j] += debts[start];
      best = Math.min(best,1+solve(start+1)); debts[j]=old;
    }
    return best;
  }
  return solve(0);
}
assert.equal(verify([-3,-2,2,3]).transfers.length,2); // Voraz por ID produciría tres.
let cases=0;
for (let count=2;count<=8;count++) {
  for (let seed=1;seed<=80;seed++) {
    const values=Array.from({length:count-1},(_,i) => ((seed*(i+3)*17+i*i*11)%19)-9);
    values.push(-values.reduce((a,b)=>a+b,0));
    assert.equal(verify(values).transfers.length,minimum(values)); cases++;
  }
}
assert.equal(verify([...Array(18).fill(-1),18]).minimumProven,false);
assert.equal(verify([...Array(17).fill(-1),17]).minimumProven,true);
assert.equal(verify([]).minimumProven,true);
assert.throws(() => planSettlement(new Map([['a',1n]]),'PEN'));
for (const bad of ['0','-1','1e2','1\n','1.123456789']) assert.throws(()=>parseExchangeRate(bad));
for (let total=1n;total<=200n;total++) {
  const expense={payerId:'payer',currency:'USD',amountMinor:total,splits:equalSplit(total,['a'])};
  const rate=parseExchangeRate('3.75');
  const converted=convertExpense(expense,rate);
  assert.equal(converted.amountMinor,(total*375n+50n)/100n);
  assert.equal(converted.splits.reduce((s,p)=>s+p.amountMinor,0n),converted.amountMinor);
  assert.equal(expense.currency,'USD');
}
const original={payerId:'payer',currency:'USD',amountMinor:10n,splits:[{participantId:'a',amountMinor:7n},{participantId:'b',amountMinor:2n},{participantId:'c',amountMinor:1n}]};
assert.deepEqual(convertExpense(original,parseExchangeRate('0.5')).splits,[{participantId:'a',amountMinor:4n},{participantId:'b',amountMinor:1n}]);
assert.equal(convertExpense({...original,amountMinor:1n,splits:equalSplit(1n,['a'])},parseExchangeRate('0.01')),null);
assert.equal([...consolidatedBalances([original],parseExchangeRate('0.5')).values()].reduce((s,n)=>s+n,0n),0n);
assert.equal(convertExpense({...original,amountMinor:1n,splits:equalSplit(1n,['a'])},parseExchangeRate('0.5')).amountMinor,1n);
console.log(`OK: ${cases} planes contrastados con oráculo exhaustivo; límite 18/fallback 19; conversión y redondeo exactos.`);
