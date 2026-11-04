# Contrato para agentes de desarrollo

Lee `README.md` y todos los documentos de `docs/` antes de implementar. Si existen contradicciones, prevalecen en este orden: requisitos de producto, seguridad y privacidad, datos y liquidación, arquitectura, backlog.

## Misión

Construir un MVP web para un único viaje fijo a Cusco. El sistema permite que un grupo fijo registre gastos en PEN y USD, los reparta entre subconjuntos de participantes y liquide deudas por gasto o de forma neta.

## Límites innegociables

- No implementar creación de viajes, registro de usuarios, recuperación de contraseñas ni funciones comerciales.
- Se pueden persistir borradores privados y candidatos temporales para recuperación. No convertirlos en gastos financieros definitivos sin revisión y confirmación explícita.
- No usar números flotantes para dinero.
- No exponer secretos, tokens privados, imágenes bancarias ni datos personales en logs, telemetría o respuestas de error.
- Un participante puede leer todos los gastos, pero solo crear, editar o eliminar gastos donde él es el pagador. El administrador puede gestionar todo.
- Toda autorización se valida en el servidor; ocultar botones en la interfaz no es un control de seguridad.
- No cambiar el modo de liquidación ni el tipo de cambio después del primer pago confirmado, salvo que el administrador anule antes todos los pagos confirmados.
- No realizar cambios destructivos en producción ni ampliar el alcance sin una decisión registrada.

## Forma de trabajo autónoma

- Toma decisiones menores usando los supuestos documentados; no interrumpas al propietario por preferencias reversibles.
- Trabaja en cortes verticales pequeños con criterios de aceptación y pruebas.
- Ejecuta revisión cruzada de producto, seguridad y calidad antes de integrar.
- No declares una fase terminada si no supera sus gates en `docs/07-autonomous-development.md`.
- Registra decisiones arquitectónicas nuevas en `docs/decisions.md`.
- Si falta una credencial o permiso externo, completa todo lo que pueda validarse localmente y reporta un único bloqueo concreto.

## Definición global de terminado

La aplicación debe funcionar en móvil y escritorio, ser accesible con teclado, mantener invariantes monetarias, impedir acceso no autorizado, sobrevivir reintentos sin duplicar datos y desplegarse mediante GitHub, Supabase y Vercel con rollback documentado.
