import type { ExpenseCommand } from '../server/expense-repository.ts';
export type PendingOperation={key:string;command:ExpenseCommand};
type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const name='cusco.pending.v1';
const encoder=new TextEncoder();
function encode(bytes:Uint8Array){return btoa(String.fromCharCode(...bytes));}
function decode(value:string){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function encryptionKey(csrf:string){
 if(csrf.length!==43)throw new Error('No se pudo preparar la recuperación privada.');
 const digest=await crypto.subtle.digest('SHA-256',encoder.encode('cusco-pending-v1:'+csrf));
 return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['encrypt','decrypt']);
}
/** Solo después de confirmar: diario cifrado en sessionStorage; clave nunca persistida. */
export async function rememberPending(pending:PendingOperation,csrf:string,storage:Store){
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const text=JSON.stringify({version:1,expiresAt:Date.now()+8*60*60*1000,...pending});
 if(encoder.encode(text).length>65536)throw new Error('La operación excede el límite admitido.');
 const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(name)},await encryptionKey(csrf),encoder.encode(text));
 storage.setItem(name,JSON.stringify({iv:encode(iv),ciphertext:encode(new Uint8Array(ciphertext))}));
}
export function forgetPending(storage:Store){storage.removeItem(name);}
export async function recoverPending(csrf:string,storage:Store):Promise<PendingOperation|null>{
 const saved=storage.getItem(name);if(!saved)return null;
 try{
  if(saved.length>100000)throw new Error();
  const envelope=JSON.parse(saved);
  if(typeof envelope.iv!=='string'||typeof envelope.ciphertext!=='string')throw new Error();
  const iv=decode(envelope.iv);if(iv.length!==12)throw new Error();
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:encoder.encode(name)},await encryptionKey(csrf),decode(envelope.ciphertext));
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext));
  if(value.version!==1||!Number.isFinite(value.expiresAt)||value.expiresAt<=Date.now()||typeof value.key!=='string'||value.key.length!==36
    ||!value.command||!['create','update','void'].includes(value.command.operation))throw new Error();
  return {key:value.key,command:value.command as ExpenseCommand};
 }catch{storage.removeItem(name);return null;}
}
