import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";
export default function LegacyEntryPage() {
  redirect("/gastos/nuevo");
}
