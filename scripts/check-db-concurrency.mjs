// Solo base efímera, ejecutado por test-db.sh tras las pruebas transaccionales.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
if (process.env.CUSCO_DB_TEST_DISPOSABLE!=='yes') throw new Error('Disposable test database required.');
function sql(statement) {
  return new Promise(resolve=>{
    const child=spawn('psql',['-X','--no-password','-qAt','-v','ON_ERROR_STOP=1','-c',statement],{stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',chunk=>{output+=chunk;});
    // Errores del driver pueden incluir SQL: no se imprimen.
    child.stderr.resume(); child.on('error',()=>resolve({ok:false,output:''}));
    child.on('close',code=>resolve({ok:code===0,output:output.trim()}));
  });
}
const trip='00000000-0000-4000-8000-000000000001', payer='40000000-0000-4000-8000-000000000001', link='50000000-0000-4000-8000-000000000001';
assert.ok((await sql(`begin;
insert into app_private.participants(id,trip_id,display_name) values('${payer}','${trip}','Concurrency fixture');
insert into app_private.access_links(id,trip_id,participant_id,role,token_hash) values('${link}','${trip}','${payer}','participant',repeat('d',64));
insert into app_private.sessions(trip_id,link_id,token_hash,link_version,expires_at) values('${trip}','${link}',repeat('4',64),1,now()+interval '1 hour');
commit;`)).ok,'concurrency fixture setup');
const command={operation:'create',payerId:payer,description:'Concurrency fixture',spentOn:'2026-01-01',amountMinor:'100',currency:'PEN',splits:[{participantId:payer,amountMinor:'100'}]};
// Todos los valores son fixtures internos; jamás interpolar entradas del usuario.
const literal=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'::jsonb";
const create=`begin; set local role cusco_bff; select app_api.mutate_expense(repeat('4',64),'60000000-0000-4000-8000-000000000001',${literal(command)}); commit;`;
const retries=await Promise.all([sql(create),sql(create)]);
assert.ok(retries.every(r=>r.ok),'concurrent retries succeed');
const first=JSON.parse(retries[0].output), second=JSON.parse(retries[1].output);
assert.deepEqual(first,second,'same result on concurrent retry');
assert.equal((await sql(`select count(*) from app_private.expenses where created_by='${link}'`)).output,'1');
const update={...command,operation:'update',id:first.id,expectedVersion:1};
const results=await Promise.all([1,2].map(i=>sql(`begin; set local role cusco_bff; select app_api.mutate_expense(repeat('4',64),'60000000-0000-4000-8000-00000000000${i+1}',${literal({...update,description:'Edit fixture '+i})}); commit;`)));
assert.equal(results.filter(r=>r.ok).length,1,'exactly one concurrent edit wins');
assert.equal((await sql(`select version from app_private.expenses where id='${first.id}'`)).output,'2');
assert.equal((await sql(`select count(*) from app_private.audit_events where entity_id='${first.id}'`)).output,'2');
console.log('OK: PostgreSQL concurrent idempotency and optimistic edits.');
