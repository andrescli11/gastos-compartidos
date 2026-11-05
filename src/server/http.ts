import { PersistenceError } from './expense-repository.ts';
import { expiredSessionCookie } from './tokens.ts';
export const privateHeaders={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export class HttpError extends Error {
  status: number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
export function jsonResponse(value:unknown,status=200,extra:Record<string,string>={}) {
  return Response.json(value,{status,headers:{...privateHeaders,...extra}});
}
export function errorResponse(error:unknown) {
  if(error instanceof HttpError) return jsonResponse({error:error.message},error.status,error.status===429?{'Retry-After':'60'}:{});
  if(error instanceof PersistenceError){
    const status={INVALID_INPUT:400,UNAUTHORIZED:401,FORBIDDEN:403,CONFLICT:409,UNAVAILABLE:503,RATE_LIMITED:429}[error.code];
    return jsonResponse({error:error.message},status,status===401?{'Set-Cookie':expiredSessionCookie}:status===429?{'Retry-After':'60'}:{});
  }
  return jsonResponse({error:'No se pudo completar la operación.'},503);
}
export function requireOrigin(request:Request,appUrl:string){
  let expected:URL;
  try{expected=new URL(appUrl);}catch{throw new PersistenceError('UNAVAILABLE');}
  if(!['http:','https:'].includes(expected.protocol)||expected.username||expected.password||expected.pathname!=='/'||expected.search||expected.hash) throw new PersistenceError('UNAVAILABLE');
  if(expected.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(expected.hostname)) throw new PersistenceError('UNAVAILABLE');
  const site=request.headers.get('sec-fetch-site');
  if(request.headers.get('origin')!==expected.origin || (site!==null&&site!=='same-origin'))throw new HttpError(403,'Solicitud no permitida.');
}
export async function readJson(request:Request,maxBytes=65536):Promise<unknown>{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new HttpError(415,'Se requiere JSON.');
  const declared=request.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||BigInt(declared)>BigInt(maxBytes)))throw new HttpError(413,'Solicitud demasiado grande.');
  const reader=request.body?.getReader();
  if(!reader)throw new HttpError(400,'Solicitud inválida.');
  const chunks:Uint8Array[]=[];let bytes=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new HttpError(413,'Solicitud demasiado grande.');}chunks.push(value);}
    const all=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));
  }catch(e){if(e instanceof HttpError)throw e;throw new HttpError(400,'JSON inválido.');}
}
