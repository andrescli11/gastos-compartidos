import { PersistenceError, parseExpenseRecord, type ExpenseRecord, type SqlExecutor } from './expense-repository.ts';
import { hashToken } from './tokens.ts';
import { paymentBalances, PaymentError, type Payment, type PaymentActor, type PaymentLedger } from '../domain/payments.ts';
export type PaymentRecord=Omit<Payment,'amountMinor'> & {amountMinor:string};
export type PaymentContext={
  actor:{id:string;role:'participant'|'admin';participantId:string|null}; ledgerVersion:number;
  configuration:{mode:'separate'}|{mode:'consolidated';rate:{numerator:string;denominator:string}};
  configurationChosenBy:string|null;participants:string[];expenses:ExpenseRecord[];payments:PaymentRecord[];
};
export type PaymentCommand=
 | {operation:'register';senderId:string;receiverId:string;amountMinor:string;currency:'PEN'|'USD';expectedLedgerVersion:number}
 | {operation:'confirm';id:string;expectedPaymentVersion:number;expectedLedgerVersion:number;reviewedLedgerVersion:number}
 | {operation:'reject';id:string;expectedPaymentVersion:number;expectedLedgerVersion:number}
 | {operation:'void';id:string;expectedPaymentVersion:number;expectedLedgerVersion:number;reason:string}
 | {operation:'configure';mode:'separate';expectedLedgerVersion:number}
 | {operation:'configure';mode:'consolidated';rateNumerator:string;rateDenominator:string;expectedLedgerVersion:number};
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&v.length===36&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
const positive=(v:unknown,digits=14):v is string=>typeof v==='string'&&v.length<=digits&&v===v.trim()&&/^[1-9][0-9]*$/.test(v);
function invalid():never{throw new PersistenceError('INVALID_INPUT');}
export function validatePaymentCommand(v:unknown):asserts v is PaymentCommand{
  if(!object(v)||!integer(v.expectedLedgerVersion))invalid();
  let allowed:string[];
  if(v.operation==='register'){
    allowed=['operation','senderId','receiverId','amountMinor','currency','expectedLedgerVersion'];
    if(!uuid(v.senderId)||!uuid(v.receiverId)||v.senderId===v.receiverId||!positive(v.amountMinor)||!['PEN','USD'].includes(v.currency as string))invalid();
  }else if(v.operation==='configure'){
    allowed=['operation','mode','expectedLedgerVersion'];
    if(v.mode==='consolidated'){allowed.push('rateNumerator','rateDenominator');if(!positive(v.rateNumerator,18)||!positive(v.rateDenominator,18))invalid();}
    else if(v.mode!=='separate')invalid();
  }else if(['confirm','reject','void'].includes(v.operation as string)){
    allowed=['operation','id','expectedPaymentVersion','expectedLedgerVersion'];
    if(!uuid(v.id)||!integer(v.expectedPaymentVersion)||v.expectedPaymentVersion===0)invalid();
    if(v.operation==='confirm'){allowed.push('reviewedLedgerVersion');if(!integer(v.reviewedLedgerVersion)||v.reviewedLedgerVersion!==v.expectedLedgerVersion)invalid();}
    if(v.operation==='void'){allowed.push('reason');if(typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>500)invalid();}
  }else invalid();
  if(Object.keys(v).some(k=>!allowed.includes(k)))invalid();
}
export function paymentLedger(context:PaymentContext):PaymentLedger{
  const actorConfig=context.configuration;
  return {version:context.ledgerVersion,configuration:actorConfig.mode==='separate'?{mode:'separate'}:{mode:'consolidated',rate:{numerator:BigInt(actorConfig.rate.numerator),denominator:BigInt(actorConfig.rate.denominator)}},configurationChosenBy:context.configurationChosenBy,participants:context.participants,
    expenses:context.expenses.map(e=>({payerId:e.payerId,currency:e.currency,amountMinor:BigInt(e.amountMinor),splits:e.splits.map(s=>({participantId:s.participantId,amountMinor:BigInt(s.amountMinor)}))})),
    payments:context.payments.map(p=>({...p,amountMinor:BigInt(p.amountMinor),voidReason:p.state==='voided'?(p.voidReason??'[motivo reservado]'):p.voidReason})),audit:[]};
}
export function paymentActor(context:PaymentContext):PaymentActor{
  return context.actor.role==='admin'?{id:context.actor.id,role:'admin'}:{id:context.actor.id,role:'participant',participantId:context.actor.participantId!};
}
export function parsePaymentContext(value:unknown):PaymentContext{
  if(!object(value)||!integer(value.ledgerVersion)||!object(value.actor)||!uuid(value.actor.id)||!['participant','admin'].includes(value.actor.role as string)
    ||(value.actor.role==='admin'?value.actor.participantId!==null:!uuid(value.actor.participantId))
    ||(value.configurationChosenBy!==null&&!uuid(value.configurationChosenBy))||!Array.isArray(value.participants)||value.participants.some(id=>!uuid(id))
    ||new Set(value.participants).size!==value.participants.length||!Array.isArray(value.expenses)||!Array.isArray(value.payments)||!object(value.configuration))throw new PersistenceError('UNAVAILABLE');
  const c=value.configuration;
  if(c.mode!=='separate'&&(c.mode!=='consolidated'||!object(c.rate)||!positive(c.rate.numerator,18)||!positive(c.rate.denominator,18)))throw new PersistenceError('UNAVAILABLE');
  if(value.actor.role==='participant'&&!value.participants.includes(value.actor.participantId))throw new PersistenceError('UNAVAILABLE');
  const payments=value.payments.map(v=>{
    if(!object(v)||!uuid(v.id)||!uuid(v.senderId)||!uuid(v.receiverId)||!positive(v.amountMinor)||!['PEN','USD'].includes(v.currency as string)||!integer(v.version)||v.version===0
      ||!uuid(v.createdBy)||[v.confirmedBy,v.rejectedBy,v.voidedBy].some(id=>id!==null&&!uuid(id))||(v.voidReason!==null&&(typeof v.voidReason!=='string'||!v.voidReason.trim()||v.voidReason.length>500)))throw new PersistenceError('UNAVAILABLE');
    if(value.actor && (value.actor as Record<string,unknown>).role!=='admin'&&v.voidReason!==null)throw new PersistenceError('UNAVAILABLE');
    return {id:v.id,senderId:v.senderId,receiverId:v.receiverId,amountMinor:v.amountMinor,currency:v.currency,state:v.state,version:v.version,createdBy:v.createdBy,confirmedBy:v.confirmedBy,rejectedBy:v.rejectedBy,voidedBy:v.voidedBy,voidReason:v.voidReason} as PaymentRecord;
  });
  const context:PaymentContext={actor:{id:value.actor.id,role:value.actor.role as PaymentContext['actor']['role'],participantId:value.actor.participantId as string|null},ledgerVersion:value.ledgerVersion,configuration:c.mode==='separate'?{mode:'separate'}:{mode:'consolidated',rate:{numerator:(c.rate as Record<string,string>).numerator,denominator:(c.rate as Record<string,string>).denominator}},configurationChosenBy:value.configurationChosenBy as string|null,participants:value.participants as string[],expenses:value.expenses.map(parseExpenseRecord),payments};
  if(context.expenses.some(e=>e.state!=='active'))throw new PersistenceError('UNAVAILABLE');
  try{paymentBalances(paymentLedger(context));}catch{throw new PersistenceError('UNAVAILABLE');}
  return context;
}
function failure(e:unknown):never{
  if(e instanceof PersistenceError||e instanceof PaymentError)throw e;
  const code=object(e)?e.code:null;
  if(code==='28000')throw new PersistenceError('UNAUTHORIZED');
  if(code==='42501')throw new PersistenceError('FORBIDDEN');
  if(code==='40001'&&object(e)&&['ledger_version_conflict','payment_version_conflict','payment_review_conflict'].includes(e.message as string))throw new PersistenceError('STALE_VERSION');
  if(['23505','40001','40P01'].includes(code as string))throw new PersistenceError('CONFLICT');
  if(code==='55000')throw new PaymentError(object(e)&&e.message==='configuration_required'?'CONFIGURATION_REQUIRED':'CONFIGURATION_LOCKED');
  if(['22023','22P02','22003','23514','23502','23503'].includes(code as string))throw new PersistenceError('INVALID_INPUT');
  throw new PersistenceError('UNAVAILABLE');
}
export class PaymentRepository{
  private database:SqlExecutor;
  constructor(database:SqlExecutor){this.database=database;}
  async context(token:string):Promise<PaymentContext>{
    try{const result=await this.database.query('select app_api.payment_context($1::text) as result',[hashToken(token)]);return parsePaymentContext(result.rows[0]?.result);}catch(e){return failure(e);}
  }
  async mutate(token:string,key:string,command:PaymentCommand):Promise<PaymentContext>{
    try{const hash=hashToken(token);if(!uuid(key))invalid();validatePaymentCommand(command);const result=await this.database.query('select app_api.mutate_payment($1::text,$2::uuid,$3::jsonb) as result',[hash,key,JSON.stringify(command)]);return parsePaymentContext(result.rows[0]?.result);}catch(e){return failure(e);}
  }
}
