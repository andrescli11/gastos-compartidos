# Gastos compartidos — Cusco

MVP de uso único para cuadrar los gastos del viaje a Cusco por la despedida de Yácole.

Este repositorio contiene el dominio financiero, la persistencia SQL y el código del flujo privado de acceso y gastos. Incluye transcripción CSV local con revisión. Todavía no se ha verificado el build ni la integración real con PostgreSQL/Supabase; no está desplegado.

## Documentos

1. [Requisitos de producto](docs/01-product-requirements.md)
2. [Arquitectura](docs/02-architecture.md)
3. [Datos y liquidación](docs/03-data-and-settlement.md)
4. [Importaciones con IA](docs/04-ai-imports.md)
5. [Seguridad y privacidad](docs/05-security-and-privacy.md)
6. [Pruebas y calidad](docs/06-testing-and-quality.md)
7. [Desarrollo autónomo](docs/07-autonomous-development.md)
8. [Backlog de implementación](docs/08-implementation-backlog.md)
9. [Bootstrap e integraciones](docs/09-bootstrap-checklist.md)
10. [Registro de decisiones](docs/decisions.md)

## Estado

- Alcance del MVP: definido.
- Stack y arquitectura: definidos.
- Implementación: fundaciones y reparto en progreso; gates pendientes.
- Lista de participantes: pendiente.
- Credenciales y red para Supabase, Vercel y OpenAI: pendientes.
- Datos de evaluación de importaciones: pendientes.

## Principio rector

Resolver bien este viaje. No construir una plataforma comercial, gestión de múltiples viajes ni registro de usuarios.

## Desarrollo local

Requiere Node.js 24 y npm. Una vez disponible la red:

```bash
npm install --save-exact
npm run dev
```

Inicio en `http://localhost:3000` con calculadora de prueba. Acceso privado en `/entrar#token=…` y gastos en `/gastos`, sujetos a configuración y validación de base real. No generar ni compartir enlaces reales hasta completar los gates.

Verificación financiera sin descargar dependencias:

```bash
npm run test:local
```

Las comprobaciones completas y los bloqueos observados están en [estado de desarrollo](docs/10-development-status.md). No se ha validado aún el build.

## Persistencia

Esquema, autorización transaccional, contratos y pruebas: [guía de persistencia](db/README.md). Las pruebas del adaptador se ejecutan con `npm run test:persistence` sin instalar dependencias. La suite PostgreSQL y el despliegue siguen pendientes de ejecución.

El [checkpoint de integración](docs/11-integration-checkpoint.md) reúne el bloqueo del entorno y la configuración externa necesaria. `npm run init:local` genera configuración local privada sin sobrescribir archivos existentes.

## Avances verificables sin entorno externo

`npm run test:payments` comprueba pagos y cierre; `npm run test:imports` comprueba revisión y confirmación por lote. Son dominios locales: persistencia/API/UI de estos dos bloques siguen pendientes. Detalles en [pagos](docs/12-offline-payment-domain.md) e [importaciones](docs/13-offline-import-workflow.md).
