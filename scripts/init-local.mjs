import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
// No imprime el secreto ni sobrescribe configuración existente.
const path=fileURLToPath(new URL('../.env.local',import.meta.url));
try{
 await writeFile(path,`APP_URL=http://localhost:3000\nDATABASE_URL=\nRATE_LIMIT_SECRET=${randomBytes(32).toString('base64url')}\n`,{flag:'wx',mode:0o600});
 console.log('Configuración local creada con permisos privados. Falta conectar la base de desarrollo.');
}catch(error){if(error.code==='EEXIST')console.log('La configuración local ya existe; no se ha modificado.');else throw new Error('No se pudo preparar la configuración local.');}
