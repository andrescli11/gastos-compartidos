import assert from 'node:assert/strict';
import { summarizePaymentLedger } from '../src/domain/payment-summary.ts';
import { configureSettlement, paymentBalances, paymentConfirmationWarnings, registerPayment, transitionPayment, PaymentError } from '../src/domain/payments.ts';
import { equalSplit } from '../src/domain/money.ts';
import { parseExchangeRate, planSettlement } from '../src/domain/settlement.ts';
const actors=Object.fromEntries(['a','b','c','d'].map(id=>[id,{id:`link-${id}`,role:'participant',participantId:id}]));
const admin={id:'link-admin',role:'admin'};
const expense=(amount=100n,currency='PEN')=>({payerId:'a',currency,amountMinor:amount,splits:[{participantId:'b',amountMinor:amount}]});
function ledger(expenses=[expense()]){return {version:0,configuration:{mode:'separate'},configurationChosenBy:admin.id,participants:['a','b','c','d'],expenses,payments:[],audit:[]};}
const draft=(id='p1',amountMinor=100n,currency='PEN')=>({id,senderId:'b',receiverId:'a',amountMinor,currency});
function fail(fn,code){assert.throws(fn,error=>error instanceof PaymentError&&error.code===code);}
function transition(book,actor,action,id='p1',extra={}){return transitionPayment(book,actor,{paymentId:id,action,expectedPaymentVersion:book.payments.find(p=>p.id===id).version,...extra},book.version);}
function deepFreeze(value){if(value&&typeof value==='object'){Object.freeze(value);for(const v of Object.values(value))deepFreeze(v);}return value;}
const initial=deepFreeze(ledger());
let book=registerPayment(initial,actors.b,draft(),0);
assert.equal(summarizePaymentLedger(initial).closed,false);
assert.equal(initial.payments.length,0);assert.equal(initial.audit.length,0);
assert.equal(book.payments[0].createdBy,'link-b');assert.equal(book.payments[0].state,'pending');
assert.equal(paymentBalances(book).PEN.get('b'),-100n);
assert.strictEqual(registerPayment(book,actors.b,draft(),0),book);
fail(()=>registerPayment(book,actors.b,draft('p1',99n),book.version),'CONFLICT');
fail(()=>registerPayment(initial,actors.a,draft(),0),'FORBIDDEN');
fail(()=>registerPayment(initial,actors.b,draft('p1',0n),0),'INVALID_INPUT');
fail(()=>registerPayment(initial,actors.b,{...draft(),receiverId:'b'},0),'INVALID_INPUT');
fail(()=>registerPayment(initial,actors.b,{...draft(),receiverId:'unknown'},0),'INVALID_INPUT');
fail(()=>registerPayment(initial,actors.b,draft('p1',1.5),0),'INVALID_INPUT');
fail(()=>transition(book,actors.b,'confirm'),'FORBIDDEN');
fail(()=>transition(book,actors.c,'reject'),'FORBIDDEN');
assert.deepEqual(paymentConfirmationWarnings(book,'p1'),[]);
fail(()=>configureSettlement(book,admin,{mode:'consolidated',rate:parseExchangeRate('3.75')},book.version),'CONFIGURATION_LOCKED');
book=transition(book,actors.a,'confirm');
assert.equal(book.payments[0].confirmedBy,'link-a');assert.equal(paymentBalances(book).PEN.get('b'),0n);
fail(()=>paymentBalances({...book,configurationChosenBy:null}),'INVALID_INPUT');
assert.equal(summarizePaymentLedger(book).closed,true);assert.equal(summarizePaymentLedger(book).configurationLocked,true);
assert.doesNotThrow(()=>JSON.stringify(summarizePaymentLedger(book)));
assert.strictEqual(transitionPayment(book,actors.a,{paymentId:'p1',action:'confirm',expectedPaymentVersion:1},0),book);
assert.strictEqual(registerPayment(book,actors.b,draft(),0),book);
fail(()=>transition(book,actors.b,'confirm'),'FORBIDDEN');
fail(()=>transition(book,admin,'reject'),'CONFLICT');
fail(()=>transitionPayment(book,admin,{paymentId:'unknown',action:'void',expectedPaymentVersion:1,reason:'fixture'},book.version),'CONFLICT');
fail(()=>transition(book,actors.a,'void','p1',{reason:'correction'}),'FORBIDDEN');
fail(()=>transition(book,admin,'void','p1',{reason:''}),'INVALID_INPUT');
fail(()=>configureSettlement(book,admin,{mode:'consolidated',rate:parseExchangeRate('3.75')},book.version),'CONFIGURATION_LOCKED');
// Corregir un gasto después del pago no altera el pago histórico.
const changed={...book,expenses:[expense(40n)]};
assert.equal(paymentBalances(changed).PEN.get('b'),60n);assert.equal(book.payments[0].amountMinor,100n);
book=transition(book,admin,'void','p1',{reason:'Private correction fixture'});
assert.equal(paymentBalances(book).PEN.get('b'),-100n);
assert.equal(book.payments[0].confirmedBy,'link-a');assert.equal(book.payments[0].voidedBy,'link-admin');
assert.strictEqual(transition(book,admin,'void','p1',{reason:'Private correction fixture'}),book);
fail(()=>transition(book,admin,'void','p1',{reason:'different'}),'CONFLICT');
assert.ok(!JSON.stringify(book.audit).includes('Private'));assert.equal(book.audit.length,3);
book=configureSettlement(book,admin,{mode:'consolidated',rate:parseExchangeRate('3.75')},book.version);
assert.equal(book.configuration.mode,'consolidated');
assert.strictEqual(configureSettlement(book,admin,{mode:'consolidated',rate:{numerator:15n,denominator:4n}},0),book);
fail(()=>configureSettlement(book,actors.a,{mode:'separate'},book.version),'FORBIDDEN');
fail(()=>registerPayment(book,actors.b,draft('usd',100n,'USD'),book.version),'INVALID_INPUT');
let rejected=registerPayment(ledger(),actors.b,draft(),0);rejected=transition(rejected,actors.a,'reject');
assert.equal(paymentBalances(rejected).PEN.get('b'),-100n);
assert.strictEqual(transition(rejected,admin,'reject'),rejected);
fail(()=>transition(rejected,actors.a,'confirm'),'CONFLICT');
assert.equal(configureSettlement(rejected,admin,{mode:'consolidated',rate:parseExchangeRate('3.5')},rejected.version).configuration.mode,'consolidated');
// Pagos parciales, con un pending que no debe alterar el libro.
let partial=registerPayment(ledger(),admin,draft('p1',37n),0);partial=transition(partial,admin,'confirm');
assert.equal(paymentBalances(partial).PEN.get('b'),-63n);
partial=registerPayment(partial,actors.b,draft('p2',63n),partial.version);
assert.equal(paymentBalances(partial).PEN.get('b'),-63n);
partial=transition(partial,actors.a,'confirm','p2');assert.equal(paymentBalances(partial).PEN.get('b'),0n);
// Dos comandos preparados contra la misma versión: el segundo debe revisar el libro.
let race=registerPayment(ledger(),actors.b,draft(),0),before=race.version;
race=transition(race,actors.a,'confirm');
fail(()=>configureSettlement(race,admin,{mode:'consolidated',rate:parseExchangeRate('3.5')},before),'CONFLICT');
assert.equal(race.configuration.mode,'separate');
// Se permite registrar una transferencia real distinta del neto solo tras revisión explícita.
let over=registerPayment(ledger(),actors.b,draft('p1',120n),0);
assert.deepEqual(paymentConfirmationWarnings(over,'p1'),['EXCEEDS_NET_DEBT','EXCEEDS_NET_CREDIT']);
fail(()=>transition(over,actors.a,'confirm'),'CONFLICT');
over=transition(over,actors.a,'confirm','p1',{reviewedLedgerVersion:over.version});
assert.equal(paymentBalances(over).PEN.get('b'),20n);
assert.equal([...paymentBalances(over).PEN.values()].reduce((s,n)=>s+n,0n),0n);
// Consolidación no reinterpreta pagos históricos anulados o rechazados en USD.
let usd=registerPayment(ledger([expense(100n,'USD')]),actors.b,draft('p1',100n,'USD'),0);
usd=transition(usd,actors.a,'confirm');assert.equal(paymentBalances(usd).USD.get('b'),0n);
usd=transition(usd,admin,'void','p1',{reason:'Fixture'});usd=configureSettlement(usd,admin,{mode:'consolidated',rate:parseExchangeRate('3.75')},usd.version);
assert.equal(summarizePaymentLedger(usd).originalExpenseTotals.USD,'100');assert.equal(summarizePaymentLedger(usd).books.PEN.totalMinor,'375');
assert.equal(paymentBalances(usd).PEN.get('b'),-375n);assert.equal(paymentBalances(usd).USD.size,0);
fail(()=>transition(over,admin,'void','p1',{reason:' '}),'INVALID_INPUT');
fail(()=>paymentBalances({...initial,expenses:[{...expense(),splits:[{participantId:'b',amountMinor:99n}]}]}),'INVALID_INPUT');
fail(()=>paymentBalances({...initial,payments:[{...partial.payments[0],currency:'EUR'}]}),'INVALID_INPUT');
fail(()=>configureSettlement(initial,admin,{mode:'consolidated',rate:{numerator:0n,denominator:1n}},0),'INVALID_INPUT');
let unchosen=registerPayment({...ledger(),configurationChosenBy:null},actors.b,draft(),0);
assert.equal(summarizePaymentLedger(unchosen).configurationChosen,false);
fail(()=>transition(unchosen,actors.a,'confirm'),'CONFIGURATION_REQUIRED');
unchosen=configureSettlement(unchosen,admin,{mode:'separate'},unchosen.version);
assert.equal(unchosen.configurationChosenBy,admin.id);
unchosen=transition(unchosen,actors.a,'confirm');assert.equal(summarizePaymentLedger(unchosen).closed,true);
let cases=0;
for(let seed=1;seed<=120;seed++){
 const expenses=Array.from({length:5},(_,i)=>{const amount=BigInt(seed*11+i*7+4);return {payerId:['a','b','c','d'][(seed+i)%4],currency:i%2?'PEN':'USD',amountMinor:amount,splits:equalSplit(amount,['a','b','c','d'])};});
 let current=ledger(expenses);
 if(seed%2)current=configureSettlement(current,admin,{mode:'consolidated',rate:parseExchangeRate('3.765')},0);
 for(const currency of ['PEN','USD']){
  const plan=planSettlement(paymentBalances(current)[currency],currency);
  for(let i=0;i<plan.transfers.length;i++){
   const transfer=plan.transfers[i],id=`${currency}-${i}`;
   current=registerPayment(current,actors[transfer.senderId],{id,...transfer},current.version);
   current=transition(current,actors[transfer.receiverId],'confirm',id);
  }
 }
 assert.equal(summarizePaymentLedger(current).closed,true);assert.doesNotThrow(()=>JSON.stringify(summarizePaymentLedger(current)));
 for(const amounts of Object.values(paymentBalances(current)))assert.ok([...amounts.values()].every(n=>n===0n));
 assert.deepEqual(paymentBalances(current),paymentBalances({...current,expenses:[...current.expenses].reverse(),payments:[...current.payments].reverse()}));cases++;
}
console.log(`OK: estados y permisos de pagos, parciales, reintentos, anulación, bloqueo de tasa y ${cases} cierres completos PEN/USD o consolidados.`);
