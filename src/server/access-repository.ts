import { PersistenceError, type SqlExecutor } from './expense-repository.ts';
import { hashToken } from './tokens.ts';
export type SessionContext = { role: 'participant' | 'admin'; participantId: string | null; participants: {id: string;displayName: string}[] };
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v:unknown):v is string {return typeof v==='string'&&v.length===36&&uuid.test(v);}
function object(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function failure(error: unknown): never {
  if(error instanceof PersistenceError) throw error;
  const code=object(error)?error.code:undefined;
  if(code==='P0001'&&object(error)&&error.message==='rate_limited') throw new PersistenceError('RATE_LIMITED');
  if(code==='28000') throw new PersistenceError('UNAUTHORIZED');
  if(code==='42501') throw new PersistenceError('FORBIDDEN');
  throw new PersistenceError('UNAVAILABLE');
}
export class AccessRepository {
  private database: SqlExecutor;
  constructor(database: SqlExecutor){this.database=database;}
  async quota(keyHash: string,scope:'exchange'|'read'|'write'|'global_exchange') {
    try{
      const r=await this.database.query('select app_api.consume_quota($1::text,$2::text) as result',[keyHash,scope]);
      if(typeof r.rows[0]?.result!=='boolean') throw new PersistenceError('UNAVAILABLE');
      return r.rows[0].result;
    }catch(e){return failure(e);}
  }
  async exchange(link:string,session:string):Promise<{expiresAt:string}>{
    try{
      const r=await this.database.query('select app_api.exchange_link($1::text,$2::text) as result',[hashToken(link),hashToken(session)]);
      const value=r.rows[0]?.result;
      if(!object(value)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt))) throw new PersistenceError('UNAVAILABLE');
      return {expiresAt:value.expiresAt};
    }catch(e){return failure(e);}
  }
  async context(token:string):Promise<SessionContext>{
    try{
      const r=await this.database.query('select app_api.session_context($1::text) as result',[hashToken(token)]);
      const v=r.rows[0]?.result;
      if(!object(v)||!['admin','participant'].includes(v.role as string)||!Array.isArray(v.participants)
        ||(v.role==='admin'?v.participantId!==null:!isUuid(v.participantId))) throw new PersistenceError('UNAVAILABLE');
      const participants=v.participants.map(p=>{
        if(!object(p)||!isUuid(p.id)||typeof p.displayName!=='string'||!p.displayName.trim()||p.displayName.length>100)throw new PersistenceError('UNAVAILABLE');
        return {id:p.id,displayName:p.displayName};
      });
      if(new Set(participants.map(p=>p.id.toLowerCase())).size!==participants.length || (v.role==='participant'&&!participants.some(p=>p.id===v.participantId)))throw new PersistenceError('UNAVAILABLE');
      return {role:v.role as SessionContext['role'],participantId:v.participantId as string|null,participants};
    }catch(e){return failure(e);}
  }
  async logout(token:string){
    try{await this.database.query('select app_api.logout_session($1::text) as result',[hashToken(token)]);}catch(e){failure(e);}
  }
  async revoke(token:string,linkId:string){
    try{
      if(!isUuid(linkId))throw new PersistenceError('INVALID_INPUT');
      const r=await this.database.query('select app_api.revoke_link($1::text,$2::uuid) as result',[hashToken(token),linkId]);
      if(r.rows[0]?.result!==true)throw new PersistenceError('UNAVAILABLE');
    }catch(e){failure(e);}
  }
}
