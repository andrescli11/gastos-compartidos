# Datos y liquidación

## 1. Principios monetarios

- Guardar dinero como enteros en la unidad menor: céntimos de PEN o USD.
- No usar `float`, `double` ni `number` para cálculos monetarios persistentes.
- Cada importe lleva una moneda explícita.
- No sumar ni comparar valores de monedas distintas sin una conversión registrada.
- Toda operación conserva la suma exacta al céntimo.

## 2. Entidades lógicas

### `trip`

Una única fila fija con nombre, fechas opcionales, zona horaria, estado, versión del libro y configuración de liquidación. Aunque solo haya un viaje, las entidades financieras conservan `trip_id` para reforzar integridad y evitar referencias cruzadas.

### `participants`

Nombre visible, estado activo y rol. La lista se carga mediante seed administrativo; no existe alta pública.

### `access_links`

SHA-256 del token aleatorio de 32 bytes, participante o rol administrativo, versión, expiración opcional, revocación y último uso. El token original nunca se persiste.

### `sessions`

Hash del token opaco de sesión, enlace de origen, expiración, última actividad y revocación. Revocar o rotar un enlace invalida de inmediato sus sesiones.

### `expenses`

Pagador, descripción, fecha, importe menor, moneda, fuente, creador, versión optimista, estado y timestamps. El borrado funcional es una anulación auditable, no una pérdida silenciosa del historial.

### `expense_splits`

Gasto, beneficiario e importe menor. Debe existir al menos una parte y la suma debe coincidir exactamente con el gasto.

### `imports` e `import_items`

Propietario, tipo de fuente, estado, huella, versión del contrato de extracción, advertencias y candidatos. Los candidatos no son gastos hasta confirmarse.

### `source_files`

Referencia privada en Storage, tipo detectado, tamaño, hash, propietario, fecha de expiración y estado de eliminación.

### `payments`

Emisor, receptor, importe menor, moneda, estado, creador, confirmador, timestamps y motivo de anulación.

### `audit_events`

Actor, acción, tipo e ID de entidad, timestamp y cambios mínimos no sensibles. No contiene tokens ni archivos.

### `idempotency_keys`

Ámbito, actor, clave, hash de solicitud, estado y referencia del resultado. Una clave reutilizada con otro payload produce conflicto.

### `rate_limits`

Cuotas persistentes por actor, viaje y operación. No dependen de memoria local de funciones serverless.

## 3. Invariantes

1. `currency ∈ {PEN, USD}`.
2. Todos los importes de gastos, partes y pagos son enteros positivos; balances derivados pueden ser negativos o cero. Candidatos de importación desconocidos pueden conservar `null`, pero no convertirse en gastos.
3. Para cada gasto: `sum(split.amount_minor) = expense.amount_minor`.
4. Para cada moneda antes de pagos: `sum(participant_balance) = 0`.
5. Un pago no puede tener el mismo emisor y receptor.
6. Solo pagos confirmados alteran saldos.
7. Confirmar, rechazar o anular un pago es idempotente y respeta su máquina de estados.
8. Una importación confirmada no puede persistir dos veces el mismo `import_item`.
9. El modo de liquidación y tipo de cambio quedan bloqueados cuando existe un pago confirmado.

## 4. Reparto

### Igual

Dividir `amount_minor` entre el número de beneficiarios. Asignar el residuo de un céntimo en orden estable por identificador de participante. La interfaz muestra esta asignación antes de confirmar. Si `amount_minor` es menor que el número de beneficiarios, rechazar el reparto para evitar partes de cero.

### Personalizado

El usuario introduce importes para todos los beneficiarios. Se rechazan valores menores a un céntimo, valores con más de dos decimales y sumas diferentes del total.

## 5. Balance

Para cada gasto y moneda:

- El pagador recibe un crédito por el importe total.
- Cada beneficiario recibe un débito por su parte, incluido el pagador si participó.

Los pagos confirmados reducen el débito del emisor y el crédito del receptor en su moneda. El balance se deriva de eventos fuente; no se guarda como una cifra editable.

## 6. Modos de liquidación

### Separada

Se calculan balances y transferencias independientes para PEN y USD. Nunca se compensan monedas.

### Consolidada a PEN

El administrador registra una tasa estrictamente positiva como razón o decimal exacto: PEN por 1 USD. Se convierte una sola vez el total de cada gasto USD usando redondeo decimal `half-up` al céntimo de PEN. Después, ese total convertido se distribuye según las partes originales USD mediante el método de mayores restos, con desempate por orden estable de participante. Así se preservan repartos personalizados y la suma exacta; una parte derivada que redondee a cero se omite del libro consolidado, sin alterar la parte original USD.

La tasa y el modo se registran con quién y cuándo los definió. No se obtiene un tipo de cambio en vivo.

## 7. Optimización de transferencias

Entrada: balances netos distintos de cero en una sola moneda o ya convertidos a PEN.

Objetivos, en orden:

1. Liquidar exactamente todos los balances.
2. Minimizar el número de transferencias para el tamaño real del grupo.
3. Producir un resultado determinista para la misma entrada.

Se implementará un algoritmo exacto basado en subconjuntos con poda para hasta 18 participantes con saldo no nulo por liquidación. Maximizar grupos disjuntos de suma cero permite obtener el mínimo de transferencias. Si el límite se supera, se usará una estrategia determinista que garantice como máximo `n-1` transferencias y la interfaz indicará “propuesta optimizada”, no “mínimo probado”.

## 8. Pagos

Estados: `pending → confirmed | rejected`; `confirmed → voided` solo por administrador con motivo.

- El emisor o el administrador crea el pago; siempre se registran por separado el emisor financiero y el actor que ejecutó la acción.
- El receptor o administrador lo confirma o rechaza.
- No se permite confirmar dos veces.
- Pagos parciales son válidos.
- Un cambio posterior en gastos puede generar un saldo nuevo o inverso; no reescribe pagos históricos.
- En liquidación separada, el pago usa PEN o USD y solo afecta su libro.
- En liquidación consolidada, todos los pagos se registran exclusivamente en PEN.
- Cambiar modo o tasa exige cero pagos confirmados y cero pagos pendientes. Los pendientes deben rechazarse o anularse antes del cambio.
- La primera confirmación de pago bloquea la fila del viaje, revalida modo, tasa, moneda y saldo, y fija la configuración en la misma transacción. Esto evita una carrera entre cambiar configuración y confirmar.

## 9. Pruebas de propiedades

- Conservación de dinero en reparto, conversión y liquidación.
- Redondeo `half-up`, mayores restos y repartos desiguales en conversiones de céntimos fraccionarios.
- Invarianza ante el orden de gastos.
- Idempotencia de comandos repetidos.
- Ninguna transferencia con importe cero, emisor igual al receptor o moneda mezclada.
- Aplicar todas las transferencias sugeridas deja todos los balances en cero.
- Confirmar el primer pago concurrentemente con un cambio de modo/tasa permite exactamente una operación válida y no deja configuración incoherente.
