# Bootstrap e integraciones

## 1. Estado observado

- Repositorio local enlazado a `https://github.com/andrescli11/gastos-compartidos.git`.
- Sin commits al redactar este documento.
- Entorno Codex Cloud operativo.
- Política de red restringida y aplicada, actualmente con preset de gestores de paquetes.
- Sin secretos, variables runtime ni identidades externas observadas como listas.
- Supabase y Vercel existen según confirmación del propietario, pero aún no están conectados al entorno.

No asumir que un token o placeholder está listo. Volver a consultar el estado observado después de configurar.

## 2. GitHub

- Configurar identidad de escritura con permiso mínimo sobre este repositorio.
- Proteger `main` con CI obligatorio.
- Permitir previews desde pull requests.
- Verificar push con un cambio documental no destructivo.

## 3. Supabase

Configurar como secretos mediante el flujo soportado, nunca por chat:

- Referencia del proyecto.
- Token de acceso para CLI/administración automatizada.
- Credencial de base de datos necesaria para migraciones.
- URL y clave pública para los contextos que realmente la necesiten.
- Credencial de servidor de mínimo privilegio para el BFF; evitar la clave de servicio amplia cuando sea posible.

Configurar red HTTP hacia endpoints de administración/API y, si las migraciones usan conexión PostgreSQL directa, el acceso TCP concreto necesario. No usar comodines más amplios de lo requerido.

Verificar:

- Proyecto y región correctos.
- Migraciones desde base vacía.
- Buckets privados.
- RLS, grants y funciones inspeccionados.
- Backup y recuperación disponibles.

## 4. Vercel

- Conectar el proyecto al repositorio GitHub.
- Rama de producción: `main`.
- Previews por pull request.
- Variables, credenciales, base de datos, Storage, enlaces y datos completamente separados para preview y producción.
- Dominio final y URL de preview incorporados a orígenes permitidos.

Una preview, incluido código no confiable de un pull request, nunca recibe secretos ni acceso a recursos de producción. Usar Supabase Branching o un proyecto Supabase dedicado para previews. Si ninguno está disponible, deshabilitar previews conectadas a datos y validar el cambio en CI/local hasta disponer de aislamiento; nunca reutilizar producción como atajo.

La integración GitHub→Vercel evita necesitar un token de Vercel para despliegues ordinarios. Solo configurar un token si una operación automatizada concreta lo exige.

## 5. OpenAI

- Guardar la clave API solo en servidor y entornos autorizados.
- Permitir el host API en la red del entorno.
- Configurar alias/modelo multimodal por entorno después de verificar visión y Structured Outputs.
- Definir presupuesto, rate limits y alertas.
- Verificar políticas de retención y controles aplicables; usar `store: false` cuando corresponda sin prometer retención cero.

## 6. Variables de aplicación

Definir nombres exactos durante F0.1 y validarlos al iniciar. Categorías esperadas:

- Supabase proyecto/servidor.
- OpenAI clave/modelo.
- Secreto de sesión y claves criptográficas que requiera el diseño final; los tokens de enlace aleatorios se almacenan mediante SHA-256.
- URL base y orígenes permitidos.
- Límites de archivos, importaciones, costes y retención.
- Identidad/configuración fija del viaje.

No exponer variables de servidor con prefijos públicos.

## 7. Red Codex Cloud

Antes de cualquier trabajo de red:

- Conservar proxy, CA y verificación TLS heredados.
- Añadir únicamente destinos concretos de GitHub, Supabase, Vercel y OpenAI necesarios.
- Si se requiere PostgreSQL directo, usar el mecanismo soportado de acceso TCP; no intentar rutas directas o desactivar proxy.
- Confirmar que la política está `enforced` y que cada secreto/identidad está `ready` con observaciones actuales.

## 8. Checkpoint único solicitado al propietario

Presentar una sola solicitud agrupada con:

1. Configuraciones exactas a añadir, sin pedir valores en el chat.
2. Dominios y acceso TCP mínimos.
3. Costes o planes que requieren aceptación.
4. Lista de participantes, fechas y archivos de evaluación.

Después del checkpoint, el desarrollo y despliegue deben continuar sin aprobaciones ordinarias.
