# Checkpoint de integración

Este es el único listado agrupado de dependencias externas. No enviar secretos ni enlaces privados por chat.

## Bloqueo que impide la siguiente verificación

Restablecer el entorno de desarrollo con:

1. Proxy HTTP operativo y acceso al registro npm ya contemplado por la política. El fallo actual es conexión al proxy, no una necesidad de desactivar TLS o ampliar la red con comodines.
2. PostgreSQL 17 y cliente psql, o Docker con socket accesible para una instancia local efímera. No hace falta Supabase real para comprobar esquema, transacciones y concurrencia.
3. Descargas del navegador Chromium de Playwright cuando se instalen las dependencias; si un host concreto está bloqueado, añadir únicamente el destino reportado por la herramienta.

No se necesita ninguna credencial de producción para esta etapa. En cuanto el entorno esté operativo se podrá instalar, fijar versiones y lockfile, ejecutar las pruebas SQL desde base vacía, corregir hasta typecheck/build y verificar el navegador. No dar por válidas esas pruebas antes de ejecutarlas.

## Configuración externa para el MVP real

- Supabase: confirmar referencia/proyecto de desarrollo y de producción separados, acceso administrativo para migraciones mediante el gestor seguro y login runtime de mínimo privilegio miembro de `cusco_bff`. `app_private` y `app_api` no se exponen por Data API.
- Runtime: `DATABASE_URL` del login BFF; `APP_URL` con origen HTTPS exacto; `RATE_LIMIT_SECRET` aleatorio de al menos 32 bytes, independiente por entorno. No usar `NEXT_PUBLIC_` para ningún secreto.
- Red: hosts concretos del proyecto/pooler Supabase y acceso TCP requerido; no pueden determinarse hasta conocer el proyecto seleccionado. Mantener proxy y validación TLS.
- Vercel: enlazar repositorio/proyecto, variables por entorno, previews aisladas de producción. Confirmar dominio/origen final.
- Datos: participantes definitivos y fechas del viaje, entregados por canal del administrador. Ningún fixture sintético se carga a producción.
- Costes y privacidad: confirmar los planes existentes antes de habilitar recursos de pago. IA permanece deshabilitada hasta corpus suficiente, presupuesto y condiciones de privacidad verificadas; no bloquea registro manual.

La clave de OpenAI y GitHub se observaron disponibles en el entorno gestionado; esto no demuestra autorización sobre ningún proyecto específico. No se imprimirán ni reutilizarán como secretos de sesión/cuota.

## Verificación que seguirá automáticamente

1. Instalar dependencias, fijar todas las versiones y generar lockfile.
2. Formato, lint, typecheck, unitarias/propiedades y build.
3. Aplicar SQL fuente en PostgreSQL efímero, ejecutar pruebas de persistencia/acceso y concurrencia; generar migración mediante CLI y ejecutar advisors cuando Supabase esté disponible.
4. Navegador móvil/escritorio, CSRF/IDOR/revocación y ausencia de datos en caché o errores.
5. Resolver hallazgos, completar pagos/ingesta restante y volver a pasar gates antes de publicar.

No se crea una preview conectada a datos reales, se ejecuta una migración destructiva ni se publica producción como sustituto de estas verificaciones.
