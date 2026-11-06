import type { Metadata } from "next";
import "./globals.css";
// Every rendered document needs a fresh CSP nonce, including link entry pages.
export const dynamic = "force-dynamic";
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
