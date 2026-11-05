import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Cusco · Gastos compartidos",
  description: "Revisa el reparto de los gastos del viaje a Cusco.",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
