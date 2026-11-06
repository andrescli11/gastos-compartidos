import Link from "next/link";

export default function ExpenseEntryPage() {
  return (
    <main>
      <header>
        <Link className="brand" href="/">
          C / <span>Cusco</span>
        </Link>
        <Link className="badge" href="/">
          Volver al dashboard
        </Link>
      </header>
      <section className="intro">
        <p className="eyebrow">INGRESAR GASTOS</p>
        <h1>¿Cómo quieres ingresarlos?</h1>
        <p>
          Elige una opción. Revisarás los importes y el reparto antes de
          confirmar los gastos.
        </p>
      </section>
      <nav className="entry-options" aria-label="Métodos de ingreso de gastos">
        <Link className="entry-option" href="/gastos/nuevo/individual">
          <span className="eyebrow">01 / INDIVIDUAL</span>
          <h2>Un gasto</h2>
          <p>
            Completa los datos, elige a los beneficiarios y revisa el reparto
            exacto.
          </p>
          <span>Registrar un gasto →</span>
        </Link>
        <Link className="entry-option" href="/gastos/nuevo/lote#manual-rows">
          <span className="eyebrow">02 / REGISTRO MASIVO</span>
          <h2>Varios gastos</h2>
          <p>
            Añade filas o pega una tabla. Corrige y selecciona los gastos que
            quieras guardar.
          </p>
          <span>Preparar un lote →</span>
        </Link>
        <Link className="entry-option" href="/gastos/nuevo/lote#prepare-data">
          <span className="eyebrow">03 / ARCHIVO</span>
          <h2>Importar Excel o CSV</h2>
          <p>
            Carga un archivo o descarga la plantilla Excel y revisa cada fila
            antes de confirmar.
          </p>
          <span>Importar un archivo →</span>
        </Link>
      </nav>
      <p className="notice">
        ¿Dejaste un lote pendiente?{" "}
        <Link href="/gastos/nuevo/lote">
          Recuperar borradores y ver resultados
        </Link>
      </p>
      <footer>CUSCO · CUENTAS CLARAS</footer>
    </main>
  );
}
