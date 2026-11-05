import { validateCustomSplit, type Currency, type Split } from './money.ts';

/** Dominio privado del servidor. Actor siempre procede de sesión validada.
 * Este módulo prepara manifests; NO escribe gastos ni equivale a una transacción DB.
 */
export type ImportActor={role:'participant';participantId:string}|{role:'admin'};
export type ImportWarning='FORMULA_LIKE_CONTENT'|'OUTSIDE_TRIP_DATES'|'NON_EXPENSE_MOVEMENT'|'INCONSISTENT_TOTALS';
export type DraftExpense={description:string|null;spentOn:string|null;amountMinor:bigint|null;currency:Currency|null;payerId:string|null;movement:'expense'|'unknown'|'refund'|'transfer';splits:readonly Split[]};
export type ImportSource={fileId:string;row:number};
export type SourceCandidate={id:string;source:ImportSource;fields:DraftExpense;warnings:readonly ImportWarning[];duplicateExpenseIds:readonly string[]};
export type ImportItem={id:string;source:ImportSource;original:DraftExpense;fields:DraftExpense;warnings:readonly ImportWarning[];duplicateExpenseIds:readonly string[];selected:boolean;revision:number;acknowledgedRevision:number|null;acknowledgedWarnings:readonly ImportWarning[];keepBoth:boolean;state:'draft'|'failed'|'persisted';expenseId:string|null;failureCode:ImportFailure|null};
export type ImportCommand={itemId:string;source:ImportSource;expense:{description:string;spentOn:string;amountMinor:bigint;currency:Currency;payerId:string;splits:readonly Split[]}};
export type ImportManifest={attemptKey:string;previewVersion:number;confirmedVersion:number;commands:readonly ImportCommand[];totals:Readonly<Record<Currency,bigint>>};
export type ImportFailure='INVALID_ROW'|'CONFLICT'|'TRANSIENT';
export type ImportResult={itemId:string;status:'persisted';expenseId:string}|{itemId:string;status:'failed';code:ImportFailure};
export type ImportReceipt={attemptKey:string;previewVersion:number;confirmedVersion:number;results:readonly ImportResult[]};
export type ImportJob={id:string;ownerId:string;participants:readonly string[];version:number;createdAt:number;expiresAt:number;phase:'preview'|'confirmed'|'persisted'|'cancelled'|'expired';items:readonly ImportItem[];manifest:ImportManifest|null;receipts:readonly ImportReceipt[];tripDates:{start:string;end:string}|null};
export type ImportWorkflowCode='INVALID_INPUT'|'FORBIDDEN'|'CONFLICT'|'EXPIRED'|'REVIEW_REQUIRED';
export class ImportWorkflowError extends Error{
 readonly code:ImportWorkflowCode;
 constructor(code:ImportWorkflowCode){super({INVALID_INPUT:'Datos de importación inválidos.',FORBIDDEN:'No puedes acceder a esta importación.',CONFLICT:'La importación cambió. Revisa su versión.',EXPIRED:'La importación temporal ha expirado.',REVIEW_REQUIRED:'Revisa los campos, advertencias y duplicados antes de confirmar.'}[code]);this.name='ImportWorkflowError';this.code=code;}
}
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=100&&v===v.trim();
const integer=(v:number)=>Number.isSafeInteger(v)&&v>=0;
const warnCodes:readonly ImportWarning[]=['FORMULA_LIKE_CONTENT','OUTSIDE_TRIP_DATES','NON_EXPENSE_MOVEMENT','INCONSISTENT_TOTALS'];
function isoDate(v:unknown):v is string{return typeof v==='string'&&v.length===10&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&v>='2000-01-01'&&v<='2100-12-31'&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;}
function copyFields(v:DraftExpense):DraftExpense{
 if((v.description!==null&&(typeof v.description!=='string'||v.description.length>16384))||(v.spentOn!==null&&(typeof v.spentOn!=='string'||v.spentOn.length>100))
 ||(v.amountMinor!==null&&(typeof v.amountMinor!=='bigint'||v.amountMinor<=0n||v.amountMinor>99999999999999n))||(v.currency!==null&&!['PEN','USD'].includes(v.currency))||(v.payerId!==null&&!id(v.payerId))
 ||!['expense','unknown','refund','transfer'].includes(v.movement)||!Array.isArray(v.splits)||v.splits.length>200||v.splits.some(s=>!id(s.participantId)||typeof s.amountMinor!=='bigint'||s.amountMinor<=0n||s.amountMinor>99999999999999n))throw new ImportWorkflowError('INVALID_INPUT');
 return {...v,splits:v.splits.map(s=>({...s}))};
}
function access(job:ImportJob,actor:ImportActor,now:number){
 if(actor.role!=='admin'&&(actor.role!=='participant'||actor.participantId!==job.ownerId))throw new ImportWorkflowError('FORBIDDEN');
 if(!integer(now))throw new ImportWorkflowError('INVALID_INPUT');
 if(now>=job.expiresAt||job.phase==='expired')throw new ImportWorkflowError('EXPIRED');
 if(job.phase==='cancelled')throw new ImportWorkflowError('CONFLICT');
}
function fresh(job:ImportJob,version:number){if(!integer(version)||version!==job.version||job.version===Number.MAX_SAFE_INTEGER)throw new ImportWorkflowError('CONFLICT');}
function editable(job:ImportJob,actor:ImportActor,version:number,now:number){access(job,actor,now);fresh(job,version);if(job.phase!=='preview')throw new ImportWorkflowError('CONFLICT');}
function currentWarnings(job:ImportJob,item:ImportItem):ImportWarning[]{
 const warnings=new Set(item.warnings);
 if(item.original.movement!=='expense')warnings.add('NON_EXPENSE_MOVEMENT');
 if(job.tripDates&&isoDate(item.fields.spentOn)&&(item.fields.spentOn<job.tripDates.start||item.fields.spentOn>job.tripDates.end))warnings.add('OUTSIDE_TRIP_DATES');
 return [...warnings].sort();
}
export function createImport(input:{id:string;ownerId:string;participants:readonly string[];candidates:readonly SourceCandidate[];tripDates?:{start:string;end:string}},actor:ImportActor,now:number):ImportJob{
 if(!id(input.id)||!id(input.ownerId)||!integer(now)||now>Number.MAX_SAFE_INTEGER-7*86400000||input.candidates.length>200||!input.participants.includes(input.ownerId)||input.participants.some(p=>!id(p))||new Set(input.participants).size!==input.participants.length)throw new ImportWorkflowError('INVALID_INPUT');
 if(actor.role!=='admin'&&(actor.role!=='participant'||actor.participantId!==input.ownerId))throw new ImportWorkflowError('FORBIDDEN');
 if(input.tripDates&&(!isoDate(input.tripDates.start)||!isoDate(input.tripDates.end)||input.tripDates.start>input.tripDates.end))throw new ImportWorkflowError('INVALID_INPUT');
 const ids=new Set<string>(),sources=new Set<string>();
 const items=input.candidates.map(candidate=>{
  const sourceKey=JSON.stringify([candidate.source.fileId,candidate.source.row]);
  if(!id(candidate.id)||ids.has(candidate.id)||!id(candidate.source.fileId)||!Number.isSafeInteger(candidate.source.row)||candidate.source.row<1||sources.has(sourceKey)
   ||candidate.warnings.some(w=>!warnCodes.includes(w))||new Set(candidate.warnings).size!==candidate.warnings.length||candidate.duplicateExpenseIds.some(v=>!id(v)))throw new ImportWorkflowError('INVALID_INPUT');
  ids.add(candidate.id);sources.add(sourceKey);
  const original=copyFields(candidate.fields);
  return {id:candidate.id,source:{...candidate.source},original,fields:copyFields(original),warnings:[...candidate.warnings],duplicateExpenseIds:[...new Set(candidate.duplicateExpenseIds)],selected:false,revision:0,acknowledgedRevision:null,acknowledgedWarnings:[],keepBoth:false,state:'draft' as const,expenseId:null,failureCode:null};
 });
 return {id:input.id,ownerId:input.ownerId,participants:[...input.participants],version:0,createdAt:now,expiresAt:now+7*86400000,phase:'preview',items,manifest:null,receipts:[],tripDates:input.tripDates?{...input.tripDates}:null};
}
export function viewImport(job:ImportJob,actor:ImportActor,now:number):ImportJob{access(job,actor,now);return job;}
export function editImportItem(job:ImportJob,actor:ImportActor,itemId:string,fields:DraftExpense,selected:boolean,expectedVersion:number,now:number):ImportJob{
 editable(job,actor,expectedVersion,now);
 const item=job.items.find(i=>i.id===itemId);if(!item||item.state==='persisted'||typeof selected!=='boolean')throw new ImportWorkflowError('CONFLICT');
 const next=copyFields(fields);
 if(actor.role==='participant'&&next.payerId!==null&&next.payerId!==actor.participantId)throw new ImportWorkflowError('FORBIDDEN');
 if((next.payerId!==null&&!job.participants.includes(next.payerId))||next.splits.some(s=>!job.participants.includes(s.participantId)))throw new ImportWorkflowError('INVALID_INPUT');
 const updated:ImportItem={...item,fields:next,selected,revision:item.revision+1,acknowledgedRevision:null,acknowledgedWarnings:[],keepBoth:false,state:'draft',failureCode:null};
 return {...job,version:job.version+1,items:job.items.map(i=>i.id===item.id?updated:i)};
}
export function acknowledgeImportItem(job:ImportJob,actor:ImportActor,itemId:string,warningCodes:readonly ImportWarning[],keepBoth:boolean,expectedVersion:number,now:number):ImportJob{
 editable(job,actor,expectedVersion,now);const item=job.items.find(i=>i.id===itemId);
 if(!item||item.state==='persisted'||typeof keepBoth!=='boolean'||new Set(warningCodes).size!==warningCodes.length||warningCodes.some(w=>!currentWarnings(job,item).includes(w)))throw new ImportWorkflowError('INVALID_INPUT');
 const updated={...item,acknowledgedRevision:item.revision,acknowledgedWarnings:[...warningCodes],keepBoth};
 return {...job,version:job.version+1,items:job.items.map(i=>i.id===item.id?updated:i)};
}
function command(job:ImportJob,item:ImportItem,actor:ImportActor):ImportCommand{
 const f=item.fields;
 if(typeof f.description!=='string'||!f.description.trim()||f.description.length>240||!isoDate(f.spentOn)||typeof f.amountMinor!=='bigint'||f.amountMinor<=0n||!f.currency||!f.payerId||f.movement!=='expense'
  ||!job.participants.includes(f.payerId)||f.splits.some(s=>!job.participants.includes(s.participantId)))throw new ImportWorkflowError('REVIEW_REQUIRED');
 if(actor.role==='participant'&&f.payerId!==actor.participantId)throw new ImportWorkflowError('FORBIDDEN');
 try{validateCustomSplit(f.amountMinor,f.splits);}catch{throw new ImportWorkflowError('REVIEW_REQUIRED');}
 const warnings=currentWarnings(job,item);
 if((warnings.length||item.duplicateExpenseIds.length)&&(item.acknowledgedRevision!==item.revision||warnings.some(w=>!item.acknowledgedWarnings.includes(w))||(item.duplicateExpenseIds.length&&!item.keepBoth)))throw new ImportWorkflowError('REVIEW_REQUIRED');
 return {itemId:item.id,source:{...item.source},expense:{description:f.description.trim(),spentOn:f.spentOn,amountMinor:f.amountMinor,currency:f.currency,payerId:f.payerId,splits:f.splits.map(s=>({...s}))}};
}
/** Único punto de confirmación humana: congela exactamente la versión revisada. */
export function confirmImport(job:ImportJob,actor:ImportActor,attemptKey:string,expectedPreviewVersion:number,now:number):ImportJob{
 access(job,actor,now);if(!id(attemptKey))throw new ImportWorkflowError('INVALID_INPUT');
 const receipt=job.receipts.find(r=>r.attemptKey===attemptKey);
 if(receipt){if(receipt.previewVersion!==expectedPreviewVersion)throw new ImportWorkflowError('CONFLICT');return job;}
 if(job.manifest?.attemptKey===attemptKey){if(job.manifest.previewVersion!==expectedPreviewVersion)throw new ImportWorkflowError('CONFLICT');return job;}
 editable(job,actor,expectedPreviewVersion,now);
 const commands=job.items.filter(i=>i.selected&&i.state!=='persisted').map(i=>command(job,i,actor));
 if(!commands.length)throw new ImportWorkflowError('REVIEW_REQUIRED');
 const totals={PEN:0n,USD:0n};for(const c of commands)totals[c.expense.currency]+=c.expense.amountMinor;
 const manifest:ImportManifest={attemptKey,previewVersion:job.version,confirmedVersion:job.version+1,commands,totals};
 return {...job,version:job.version+1,phase:'confirmed',manifest};
}
const resultString=(results:readonly ImportResult[])=>JSON.stringify([...results].sort((a,b)=>a.itemId<b.itemId?-1:a.itemId>b.itemId?1:0).map(r=>[r.itemId,r.status,r.status==='persisted'?r.expenseId:r.code]));
/** SOLO adaptador de persistencia confiable, dentro de la transacción que escribe
 * gastos y recibos. Nunca aceptar results del navegador como prueba de guardado.
 */
export function applyImportResults(job:ImportJob,attemptKey:string,expectedConfirmedVersion:number,results:readonly ImportResult[],now:number):ImportJob{
 if(!integer(now)||now>=job.expiresAt)throw new ImportWorkflowError('EXPIRED');
 const old=job.receipts.find(r=>r.attemptKey===attemptKey);
 if(old){if(old.confirmedVersion!==expectedConfirmedVersion||resultString(old.results)!==resultString(results))throw new ImportWorkflowError('CONFLICT');return job;}
 const manifest=job.manifest;
 if(job.phase!=='confirmed'||!manifest||manifest.attemptKey!==attemptKey||manifest.confirmedVersion!==expectedConfirmedVersion||job.version!==expectedConfirmedVersion)throw new ImportWorkflowError('CONFLICT');
 if(results.length!==manifest.commands.length||new Set(results.map(r=>r.itemId)).size!==results.length)throw new ImportWorkflowError('INVALID_INPUT');
 const expenseIds=new Set(job.items.flatMap(i=>i.expenseId?[i.expenseId]:[]));
 for(const r of results){
  if(!manifest.commands.some(c=>c.itemId===r.itemId))throw new ImportWorkflowError('INVALID_INPUT');
  if(r.status==='persisted'){if(!id(r.expenseId)||expenseIds.has(r.expenseId))throw new ImportWorkflowError('INVALID_INPUT');expenseIds.add(r.expenseId);}
  else if(r.status!=='failed'||!['INVALID_ROW','CONFLICT','TRANSIENT'].includes(r.code))throw new ImportWorkflowError('INVALID_INPUT');
 }
 const items=job.items.map(item=>{
  const r=results.find(r=>r.itemId===item.id);if(!r)return item;
  if(r.status==='failed')return {...item,state:'failed' as const,failureCode:r.code};
  // Retener únicamente el contenido revisado que realmente fue confirmado.
  const expense=manifest.commands.find(c=>c.itemId===item.id)!.expense;
  const reviewed:DraftExpense={...expense,movement:'expense',splits:expense.splits.map(s=>({...s}))};
  return {...item,original:copyFields(reviewed),fields:copyFields(reviewed),warnings:[],duplicateExpenseIds:[],acknowledgedRevision:null,acknowledgedWarnings:[],keepBoth:false,state:'persisted' as const,expenseId:r.expenseId,selected:false,failureCode:null};
 });
 const receipt:ImportReceipt={attemptKey,previewVersion:manifest.previewVersion,confirmedVersion:manifest.confirmedVersion,results:results.map(r=>({...r}))};
 const completed=items.every(i=>i.state==='persisted'||!i.selected);
 return {...job,version:job.version+1,phase:completed?'persisted':'preview',items:completed?items.filter(i=>i.state==='persisted'):items,tripDates:completed?null:job.tripDates,manifest:null,receipts:[...job.receipts,receipt]};
}
export function cancelImport(job:ImportJob,actor:ImportActor,expectedVersion:number,now:number):ImportJob{
 access(job,actor,now);fresh(job,expectedVersion);if(job.phase==='confirmed')throw new ImportWorkflowError('CONFLICT');
 return {...job,phase:'cancelled',version:job.version+1,items:[],manifest:null,receipts:[],tripDates:null};
}
/** Limpieza temporal confiable: elimina candidatos/evidencias al vencer el TTL.
 * Las referencias financieras confirmadas viven en gastos/auditoría externos.
 */
export function expireImport(job:ImportJob,now:number):ImportJob{
 if(!integer(now))throw new ImportWorkflowError('INVALID_INPUT');
 if(now<job.expiresAt)throw new ImportWorkflowError('CONFLICT');
 if(job.phase==='expired')return job;
 return {...job,phase:'expired',version:job.version+1,items:[],manifest:null,receipts:[],tripDates:null};
}
