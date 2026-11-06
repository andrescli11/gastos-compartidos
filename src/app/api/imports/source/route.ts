import { authorizeImport } from "@/server/import-auth";
import { errorResponse, HttpError, jsonResponse } from "@/server/http";
import { ExcelSourceError, parseXlsx } from "@/server/excel-source";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Stay below the Vercel Function request-body ceiling. Parser has a separate 15 MB hard cap.
const UPLOAD_BYTES = 4 * 1024 * 1024;
/** Original is bounded and parsed in memory, never uploaded to a public bucket or retained. */
export async function POST(request: Request) {
  try {
    await authorizeImport(request, true);
    const type = request.headers.get("content-type")?.split(";")[0];
    if (
      ![
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/octet-stream",
      ].includes(type || "")
    )
      throw new HttpError(415, "Selecciona un archivo .xlsx sin macros.");
    const declared = request.headers.get("content-length");
    if (
      declared &&
      (!/^\d+$/.test(declared) || Number(declared) > UPLOAD_BYTES)
    )
      throw new HttpError(413, "El archivo supera el límite de 4 MB.");
    if (!request.body) throw new HttpError(400, "Selecciona un archivo Excel.");
    const reader = request.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > UPLOAD_BYTES) {
          await reader.cancel();
          throw new HttpError(413, "El archivo supera el límite de 4 MB.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const source = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      source.set(chunk, at);
      at += chunk.length;
    }
    return jsonResponse(parseXlsx(source));
  } catch (error) {
    return errorResponse(
      error instanceof ExcelSourceError
        ? new HttpError(400, error.message)
        : error,
    );
  }
}
