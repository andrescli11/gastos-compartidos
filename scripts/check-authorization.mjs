import assert from 'node:assert/strict';
import {canCreateExpense,canEditExpense,canDeleteExpense,canRegisterPayment,canReviewPayment,canAdminister} from '../src/domain/authorization.ts';
const admin={role:'admin'}, a={role:'participant',participantId:'a'}, b={role:'participant',participantId:'b'};
for (const actor of [admin,a,b]) {
 for (const payer of ['a','b']) {
  const owns=actor.role==='admin'||actor.participantId===payer;
  assert.equal(canCreateExpense(actor,payer),owns);
  assert.equal(canDeleteExpense(actor,payer),owns);
  assert.equal(canRegisterPayment(actor,payer),owns);
  assert.equal(canReviewPayment(actor,payer),owns);
  for (const proposed of ['a','b']) assert.equal(canEditExpense(actor,payer,proposed),actor.role==='admin'||(actor.participantId===payer&&payer===proposed));
 }
 assert.equal(canAdminister(actor),actor.role==='admin');
 assert.equal(canCreateExpense(actor,''),false);
}
assert.equal(canEditExpense(a,'b','a'),false); // No apropiarse del gasto ajeno.
assert.equal(canCreateExpense({role:'participant',participantId:''},''),false);
console.log('OK: matriz de políticas crear/editar/anular gastos y registrar/revisar pagos; sin endpoints habilitados.');
