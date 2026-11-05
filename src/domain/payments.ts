import { calculateBalances, type Currency, type Expense } from './money.ts';
import { consolidatedBalances, type ExchangeRate } from './settlement.ts';
import { canAdminister, canRegisterPayment, canReviewPayment, type Actor } from './authorization.ts';

export type SettlementConfiguration = { mode: 'separate' } | { mode: 'consolidated'; rate: ExchangeRate };
export type PaymentState = 'pending' | 'confirmed' | 'rejected' | 'voided';
export type Payment = {
  id: string; senderId: string; receiverId: string; amountMinor: bigint; currency: Currency;
  state: PaymentState; version: number; createdBy: string;
  confirmedBy: string | null; rejectedBy: string | null; voidedBy: string | null; voidReason: string | null;
};
export type PaymentActor = Actor & { id: string };
export type PaymentAudit = {
  action: 'payment.register' | 'payment.confirm' | 'payment.reject' | 'payment.void' | 'settlement.configure';
  entityId: string | null; actorId: string; ledgerVersion: number;
};
export type PaymentLedger = {
  version: number; configuration: SettlementConfiguration; configurationChosenBy: string | null; participants: readonly string[];
  expenses: readonly Expense[]; payments: readonly Payment[]; audit: readonly PaymentAudit[];
};
export type PaymentErrorCode = 'INVALID_INPUT' | 'FORBIDDEN' | 'CONFLICT' | 'CONFIGURATION_LOCKED' | 'CONFIGURATION_REQUIRED';
export class PaymentError extends Error {
  readonly code: PaymentErrorCode;
  constructor(code: PaymentErrorCode) {
    super({ INVALID_INPUT:'Datos de pago inválidos.', FORBIDDEN:'No puedes realizar esta acción.', CONFLICT:'El pago o el libro cambió. Revisa su estado.', CONFIGURATION_REQUIRED:'El administrador debe elegir la liquidación antes de confirmar pagos.', CONFIGURATION_LOCKED:'Resuelve los pagos pendientes y anula los confirmados antes de cambiar la liquidación.' }[code]);
    this.name='PaymentError'; this.code=code;
  }
}
const validId=(id:unknown):id is string=>typeof id==='string'&&!!id.trim()&&id.length<=100;
const positive=(n:unknown):n is bigint=>typeof n==='bigint'&&n>0n&&n<=99999999999999n;
const version=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
function configuration(config:SettlementConfiguration) {
  if(config.mode==='separate')return;
  if(config.mode!=='consolidated'||typeof config.rate?.numerator!=='bigint'||typeof config.rate?.denominator!=='bigint'||config.rate.numerator<=0n||config.rate.denominator<=0n)throw new PaymentError('INVALID_INPUT');
}
function participant(ledger:PaymentLedger,id:string){return validId(id)&&ledger.participants.includes(id);}
function validateLedger(ledger:PaymentLedger){
  configuration(ledger.configuration);
  if((ledger.configurationChosenBy!==null&&!validId(ledger.configurationChosenBy))||!version(ledger.version)||ledger.participants.some(id=>!validId(id))||new Set(ledger.participants).size!==ledger.participants.length)throw new PaymentError('INVALID_INPUT');
  for(const expense of ledger.expenses){
    if(!participant(ledger,expense.payerId)||!positive(expense.amountMinor)||expense.splits.some(s=>!participant(ledger,s.participantId)||!positive(s.amountMinor)))throw new PaymentError('INVALID_INPUT');
  }
  try{calculateBalances(ledger.expenses);}catch{throw new PaymentError('INVALID_INPUT');}
  const ids=new Set<string>();
  for(const p of ledger.payments){
    if(!validId(p.id)||ids.has(p.id)||!participant(ledger,p.senderId)||!participant(ledger,p.receiverId)||p.senderId===p.receiverId||!positive(p.amountMinor)||!['PEN','USD'].includes(p.currency)
      ||!['pending','confirmed','rejected','voided'].includes(p.state)||!version(p.version)||p.version===0||!validId(p.createdBy))throw new PaymentError('INVALID_INPUT');
    ids.add(p.id);
    if(p.state==='confirmed'&&ledger.configurationChosenBy===null)throw new PaymentError('INVALID_INPUT');
    if(p.state==='pending'&&(p.confirmedBy!==null||p.rejectedBy!==null||p.voidedBy!==null||p.voidReason!==null))throw new PaymentError('INVALID_INPUT');
    if(p.state==='confirmed'&&(!validId(p.confirmedBy)||p.rejectedBy!==null||p.voidedBy!==null||p.voidReason!==null))throw new PaymentError('INVALID_INPUT');
    if(p.state==='rejected'&&(!validId(p.rejectedBy)||p.confirmedBy!==null||p.voidedBy!==null||p.voidReason!==null))throw new PaymentError('INVALID_INPUT');
    if(p.state==='voided'&&(!validId(p.confirmedBy)||!validId(p.voidedBy)||p.rejectedBy!==null||!p.voidReason?.trim()||p.voidReason.length>500))throw new PaymentError('INVALID_INPUT');
    if(ledger.configuration.mode==='consolidated'&&['pending','confirmed'].includes(p.state)&&p.currency!=='PEN')throw new PaymentError('INVALID_INPUT');
  }
}
function authorize(ledger:PaymentLedger,actor:PaymentActor){
  if(!validId(actor.id)||(actor.role!=='admin'&&(actor.role!=='participant'||!participant(ledger,actor.participantId))))throw new PaymentError('FORBIDDEN');
}
function fresh(ledger:PaymentLedger,expected:number){if(!version(expected)||expected!==ledger.version||ledger.version===Number.MAX_SAFE_INTEGER)throw new PaymentError('CONFLICT');}
function append(ledger:PaymentLedger,actor:PaymentActor,action:PaymentAudit['action'],entityId:string|null,payments:readonly Payment[],config=ledger.configuration):PaymentLedger {
  return {...ledger,configuration:config,configurationChosenBy:action==='settlement.configure'?actor.id:ledger.configurationChosenBy,version:ledger.version+1,payments,audit:[...ledger.audit,{action,entityId,actorId:actor.id,ledgerVersion:ledger.version+1}]};
}

/** Solo pagos confirmados alteran el libro. Las fuentes originales nunca se reescriben. */
export function paymentBalances(ledger:PaymentLedger):Record<Currency,Map<string,bigint>>{
  validateLedger(ledger);
  const books=ledger.configuration.mode==='separate'?calculateBalances(ledger.expenses):{PEN:consolidatedBalances(ledger.expenses,ledger.configuration.rate),USD:new Map<string,bigint>()};
  for(const p of ledger.payments){
    if(p.state!=='confirmed')continue;
    const book=books[p.currency];book.set(p.senderId,(book.get(p.senderId)??0n)+p.amountMinor);book.set(p.receiverId,(book.get(p.receiverId)??0n)-p.amountMinor);
  }
  return books;
}
export type NewPayment = Pick<Payment,'id'|'senderId'|'receiverId'|'amountMinor'|'currency'>;
export function registerPayment(ledger:PaymentLedger,actor:PaymentActor,input:NewPayment,expectedLedgerVersion:number):PaymentLedger{
  validateLedger(ledger);authorize(ledger,actor);
  if(!canRegisterPayment(actor,input.senderId))throw new PaymentError('FORBIDDEN');
  if(!validId(input.id)||!participant(ledger,input.senderId)||!participant(ledger,input.receiverId)||input.senderId===input.receiverId||!positive(input.amountMinor)||!['PEN','USD'].includes(input.currency))throw new PaymentError('INVALID_INPUT');
  const old=ledger.payments.find(p=>p.id===input.id);
  if(old){
    if(old.createdBy!==actor.id||old.senderId!==input.senderId||old.receiverId!==input.receiverId||old.amountMinor!==input.amountMinor||old.currency!==input.currency)throw new PaymentError('CONFLICT');
    return ledger;
  }
  fresh(ledger,expectedLedgerVersion);
  if(ledger.configuration.mode==='consolidated'&&input.currency!=='PEN')throw new PaymentError('INVALID_INPUT');
  const payment:Payment={...input,state:'pending',version:1,createdBy:actor.id,confirmedBy:null,rejectedBy:null,voidedBy:null,voidReason:null};
  return append(ledger,actor,'payment.register',payment.id,[...ledger.payments,payment]);
}
export type ConfirmationWarning='SENDER_HAS_NO_NET_DEBT'|'RECEIVER_HAS_NO_NET_CREDIT'|'EXCEEDS_NET_DEBT'|'EXCEEDS_NET_CREDIT';
/** Un pago externo legítimo puede liquidar una obligación por gasto aunque difiera
 * del neto. Mostrar advertencias y exigir revisión explícita, sin inventar un límite.
 */
export function paymentConfirmationWarnings(ledger:PaymentLedger,paymentId:string):ConfirmationWarning[]{
  const books=paymentBalances(ledger),p=ledger.payments.find(p=>p.id===paymentId);
  if(!p||p.state!=='pending')throw new PaymentError('CONFLICT');
  const sender=books[p.currency].get(p.senderId)??0n,receiver=books[p.currency].get(p.receiverId)??0n;
  const warnings:ConfirmationWarning[]=[];
  if(sender>=0n)warnings.push('SENDER_HAS_NO_NET_DEBT');else if(p.amountMinor> -sender)warnings.push('EXCEEDS_NET_DEBT');
  if(receiver<=0n)warnings.push('RECEIVER_HAS_NO_NET_CREDIT');else if(p.amountMinor>receiver)warnings.push('EXCEEDS_NET_CREDIT');
  return warnings;
}
export type PaymentTransition={paymentId:string;action:'confirm'|'reject'|'void';expectedPaymentVersion:number;reason?:string;reviewedLedgerVersion?:number};
export function transitionPayment(ledger:PaymentLedger,actor:PaymentActor,command:PaymentTransition,expectedLedgerVersion:number):PaymentLedger{
  validateLedger(ledger);authorize(ledger,actor);
  const p=ledger.payments.find(p=>p.id===command.paymentId);
  if(!p)throw new PaymentError('CONFLICT');
  if(command.action!=='confirm'&&command.action!=='reject'&&command.action!=='void')throw new PaymentError('INVALID_INPUT');
  if(command.action==='void'?!canAdminister(actor):!canReviewPayment(actor,p.receiverId))throw new PaymentError('FORBIDDEN');
  if(command.action==='void'&&(typeof command.reason!=='string'||!command.reason.trim()||command.reason.length>500))throw new PaymentError('INVALID_INPUT');
  const target={confirm:'confirmed',reject:'rejected',void:'voided'} as const;
  if(p.state===target[command.action]){
    if(command.action==='void'&&p.voidReason!==command.reason!.trim())throw new PaymentError('CONFLICT');
    return ledger;
  }
  fresh(ledger,expectedLedgerVersion);
  if(p.version===Number.MAX_SAFE_INTEGER||command.expectedPaymentVersion!==p.version)throw new PaymentError('CONFLICT');
  if((command.action==='void'&&p.state!=='confirmed')||(command.action!=='void'&&p.state!=='pending'))throw new PaymentError('CONFLICT');
  if(command.action==='confirm'){
    if(ledger.configurationChosenBy===null)throw new PaymentError('CONFIGURATION_REQUIRED');
    const warnings=paymentConfirmationWarnings(ledger,p.id);
    if(warnings.length&&command.reviewedLedgerVersion!==ledger.version)throw new PaymentError('CONFLICT');
  }
  const updated:Payment={...p,state:target[command.action],version:p.version+1,
    ...(command.action==='confirm'?{confirmedBy:actor.id}:command.action==='reject'?{rejectedBy:actor.id}:{voidedBy:actor.id,voidReason:command.reason!.trim()})};
  return append(ledger,actor,`payment.${command.action}`,p.id,ledger.payments.map(item=>item.id===p.id?updated:item));
}
export function configureSettlement(ledger:PaymentLedger,actor:PaymentActor,next:SettlementConfiguration,expectedLedgerVersion:number):PaymentLedger{
  validateLedger(ledger);authorize(ledger,actor);configuration(next);
  if(!canAdminister(actor))throw new PaymentError('FORBIDDEN');
  const current=ledger.configuration;
  const same=current.mode===next.mode&&(current.mode==='separate'||(next.mode==='consolidated'&&current.rate.numerator*next.rate.denominator===next.rate.numerator*current.rate.denominator));
  if(same&&ledger.configurationChosenBy!==null)return ledger;
  fresh(ledger,expectedLedgerVersion);
  if(!same&&ledger.payments.some(p=>p.state==='pending'||p.state==='confirmed'))throw new PaymentError('CONFIGURATION_LOCKED');
  const copy:SettlementConfiguration=next.mode==='separate'?{mode:'separate'}:{mode:'consolidated',rate:{...next.rate}};
  return append(ledger,actor,'settlement.configure',null,ledger.payments,copy);
}
