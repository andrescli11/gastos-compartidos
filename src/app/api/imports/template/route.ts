import { excelTemplateResponse } from "@/server/excel-template";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Public generic template: contains no trip data and needs no database connection. */
export function GET() {
  return excelTemplateResponse();
}
