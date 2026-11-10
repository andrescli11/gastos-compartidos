# Gastos compartidos — Cusco

App privada para registrar, repartir y liquidar los gastos del único viaje a Cusco.

**MVP operativo:** [abrir la app](https://gastos-compartidos-preview.vercel.app). Los participantes y el administrador pueden elegir su usuario e introducir su PIN de tres dígitos; los enlaces privados siguen disponibles durante la transición. El inicio muestra el dashboard y el CTA «Ingresar gastos» reúne el registro individual, por lote y desde Excel/CSV. El simulador independiente sigue disponible en `/simulador` y no guarda movimientos.

## Funciones disponibles

- Gastos PEN/USD con reparto igual o personalizado, revisión, edición y anulación autorizadas.
- Balances, propuesta de transferencias, liquidación separada o consolidada y pagos con confirmación del receptor.
- Registro individual o por lote, pegado tabular, CSV y Excel, con «Agregar» y «Cancelar» y confirmación mediante modal.
- Evidencia, advertencias de fechas/duplicados, selección y confirmación versionada; reintentos sin duplicar filas.
- [Plantilla Excel descargable](https://gastos-compartidos-preview.vercel.app/api/imports/template), con hoja Gastos vacía e instrucciones. CSV hasta 15 MB; Excel .xlsx hasta 4 MB.
- Administración de enlaces: renovar y revocar con confirmación. Limpieza horaria de temporales y recuperación documentada.

La extracción de imágenes con IA permanece deshabilitada según Gate E: requiere corpus, presupuesto y condiciones de privacidad aprobados. El resto del MVP funciona sin ella. Los originales Excel se procesan en memoria y se descartan; CSV se procesa en el navegador. No se envían archivos a un proveedor de IA.

## Estado y evidencia

La app usa el Supabase real del propietario; no se creó otro proyecto de pruebas. Hay siete participantes y fechas del 29 de octubre al 2 de noviembre de 2026. Los secretos están solo en el target production de Vercel y la cuenta runtime tiene permisos limitados.

[Verificación de liberación](docs/17-release-verification.md) reúne Quality, PostgreSQL, restauración, recorrido real de navegador y revisión independiente. Las pruebas financieras con fixtures se ejecutan exclusivamente en la instancia efímera de CI; nunca contra Supabase real.

## Desarrollo

Node.js 24 y npm, con dependencias y lockfile fijados:

```bash
npm ci
npm run dev
```

La configuración del servidor usa las variables de [.env.example](.env.example), sin guardar secretos en Git. Sin configuración válida, las rutas privadas fallan cerradas. No copiar credenciales de producción a previews o entornos locales.

```bash
npm run test:local
npm test
npm run lint
npm run typecheck
npm run build
npx playwright test
```

`test:local` no requiere descargar dependencias; las comprobaciones completas necesitan `npm ci`. La suite SQL se invoca en CI mediante `scripts/test-db.sh` y rechaza entornos sin flags explícitos de base desechable.

## Operación

- [Persistencia y permisos](db/README.md)
- [Conexión real](docs/15-live-supabase.md)
- [Respaldo cifrado, restauración, rollback y recuperación de accesos](docs/16-operations-runbook.md)
- [Decisiones](docs/decisions.md)
- [Requisitos](docs/01-product-requirements.md), [seguridad](docs/05-security-and-privacy.md) y [gates](docs/07-autonomous-development.md)

Los enlaces privados y los respaldos con datos se entregan fuera del repositorio.
