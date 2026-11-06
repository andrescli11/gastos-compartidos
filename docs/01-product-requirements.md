# Requisitos de producto

## 1. Contexto y objetivo

Un grupo fijo regresó de un viaje a Cusco por la despedida de solteros de Yácole. Varias personas pagaron gastos diferentes y cada gasto puede corresponder a un subconjunto distinto del grupo.

El MVP debe permitir registrar esos gastos con la menor fricción posible, verificar los importes y repartos, entender quién debe a quién y cerrar las cuentas con pocas transferencias. El éxito se mide por completar el cuadre real de este viaje, no por preparar un producto comercial reutilizable.

## 2. Usuarios y acceso

### Participante

Accede mediante un enlace privado, aleatorio y revocable que lo identifica sin crear una cuenta.

Puede:

- Leer todos los gastos, repartos, comprobantes autorizados, balances y pagos del viaje.
- Crear, editar y eliminar únicamente gastos donde él figura como pagador.
- Importar sus propios gastos de forma manual, masiva, desde Excel/CSV o desde imágenes.
- Registrar pagos que él realiza y confirmar o rechazar pagos que recibe.

No puede cambiar el pagador de un gasto propio ni modificar gastos pagados por otra persona.

### Administrador

Accede mediante un enlace administrativo independiente. Puede gestionar todos los gastos, asignar pagadores, revocar enlaces, corregir datos, elegir el modo de liquidación y anular pagos mediante acciones auditadas.

## 3. Alcance funcional

### 3.1 Consulta

- Resumen separado de PEN y USD.
- Lista completa de gastos con búsqueda y filtros por pagador, moneda y fecha.
- Detalle de importe, moneda, fecha, descripción, pagador, fuente y reparto.
- Vista de la participación y saldo de la persona que consulta.

### 3.2 Registro individual

Campos mínimos: descripción, fecha, importe, moneda, pagador y uno o más participantes beneficiarios.

- Monedas admitidas: PEN y USD.
- El reparto es igual por defecto.
- Se permiten importes personalizados como excepción.
- El pagador puede estar o no dentro del reparto.
- Antes de guardar se muestra el reparto exacto al centavo.

### 3.3 Registro masivo

- Tabla editable con varias filas.
- Pegado de datos tabulares.
- Validación y errores por fila.
- Confirmación de todas las filas válidas seleccionadas en una operación idempotente.

### 3.4 Importación

- Excel y CSV.
- Capturas con uno o varios movimientos bancarios.
- Fotografías de boletas o comprobantes.
- La IA produce candidatos, no gastos definitivos.
- Una previsualización permite corregir, seleccionar o descartar cada candidato.
- Se muestran campos inciertos, advertencias, exclusiones y posibles duplicados.
- Se pueden guardar borradores privados y temporales para recuperar el trabajo, pero ninguna fila se convierte en gasto financiero antes de la confirmación explícita.

### 3.5 Cuadre

- Vista por gasto: obligaciones originadas por cada gasto.
- Vista neta separada por moneda.
- Plan de transferencias reducido y determinista.
- Opción administrativa para consolidar USD a PEN usando un tipo de cambio acordado y visible.
- Registro de pagos pendientes, confirmados, rechazados o anulados.

## 4. Reglas de negocio

1. El importe debe ser positivo y expresarse con dos decimales como máximo.
2. Todo gasto tiene exactamente una moneda: PEN o USD.
3. Todo gasto tiene exactamente un pagador y al menos un beneficiario.
4. Las partes deben sumar exactamente el importe del gasto.
5. En reparto igual, cualquier centavo residual se asigna de manera determinista y visible.
6. Cada beneficiario debe recibir al menos un céntimo. Si el importe en céntimos es menor que el número de beneficiarios, se debe reducir la selección o usar un gasto distinto; no se crean partes de cero.
7. Un participante solo gestiona gastos cuyo `payer` es él; el administrador gestiona cualquiera.
8. Los pagos pendientes no modifican saldos. Solo los pagos confirmados lo hacen.
9. Antes del primer pago confirmado, el administrador elige liquidación separada por moneda o consolidada a PEN.
10. Tras el primer pago confirmado, el modo y el tipo de cambio quedan bloqueados. Para cambiarlos, el administrador debe anular primero todos los pagos confirmados.
11. Las sugerencias de transferencia son derivadas; los saldos se recalculan desde gastos y pagos confirmados.
12. Editar o eliminar un gasto después de pagos confirmados conserva historial y puede originar nuevos saldos.

## 5. Recorridos principales

### Registrar un gasto

Abrir enlace → dashboard → «Ingresar gastos» → elegir registro individual → completar datos → seleccionar beneficiarios → revisar reparto → guardar → ver saldo actualizado.

### Importar gastos

Abrir enlace → dashboard → «Ingresar gastos» → elegir lote o archivo → cargar archivo → procesar → revisar candidatos junto a su evidencia → corregir y asignar beneficiarios → confirmar selección → ver resultado por fila y totales PEN/USD.

### Liquidar el viaje

Revisar gastos → resolver advertencias → elegir modo de liquidación → si aplica, definir tipo de cambio → generar plan → realizar pagos fuera de la aplicación → registrar y confirmar pagos → alcanzar saldos cero.

## 6. Estados y errores obligatorios

- Viaje sin gastos.
- Enlace inválido o revocado sin revelar datos.
- Archivo incompatible, corrupto, protegido o demasiado grande.
- Extracción en progreso, parcial, fallida o reintentable.
- Campos obligatorios ausentes o ambiguos.
- Reparto que no cuadra al centavo.
- Posible duplicado, con opción explícita de conservar ambos.
- Conflicto por edición concurrente.
- Cambio de datos con pagos ya confirmados.
- Reintento de una operación ya completada sin duplicar registros.

## 7. Criterios de éxito

- Todos los gastos reales del viaje pueden registrarse sin trabajo manual externo de consolidación.
- La suma de balances es cero por moneda antes de aplicar pagos.
- Todos los usuarios pueden explicar el origen de su saldo desde gastos concretos.
- El plan de liquidación lleva los saldos a cero y no contiene ciclos innecesarios.
- Ningún usuario modifica gastos ajenos mediante interfaz o llamadas directas.
- Las importaciones pueden persistir borradores privados recuperables, pero nunca gastos financieros no confirmados.
- Los reintentos no crean duplicados.

## 8. Fuera de alcance

- Creación o administración de otros viajes.
- Registro de usuarios, contraseñas o recuperación de cuenta.
- Aplicaciones nativas.
- Integración bancaria o ejecución de pagos.
- Tipos de cambio en vivo.
- Notificaciones, chat, presupuestos o analítica comercial.
- Repartos por porcentajes o ponderaciones; los repartos personalizados se expresan como importes.
- Edición colaborativa en tiempo real.

## 9. Insumos todavía pendientes

- Lista definitiva de participantes y nombres visibles.
- Fecha inicial y final del viaje para advertencias de importación.
- Muestras autorizadas o sintéticas de Excel, capturas y boletas.
- Decisión final del grupo sobre liquidación separada o consolidada; puede tomarse en la propia aplicación antes del primer pago.
