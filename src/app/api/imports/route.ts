import { authorizeImport } from "@/server/import-auth";
import { sqlExecutor } from "@/server/database";
import {
  errorResponse,
  HttpError,
  jsonResponse,
  readJson,
} from "@/server/http";
import { ImportRepository } from "@/server/import-repository";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const { session } = await authorizeImport(request, false);
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some((k) => k !== "id") ||
      url.searchParams.getAll("id").length > 1
    )
      throw new HttpError(400, "Revisa la solicitud.");
    return jsonResponse(
      await new ImportRepository(sqlExecutor()).list(
        session,
        url.searchParams.get("id") ?? undefined,
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request) {
  try {
    const { session } = await authorizeImport(request, true);
    const key = request.headers.get("idempotency-key") ?? "";
    return jsonResponse(
      await new ImportRepository(sqlExecutor()).mutate(
        session,
        key,
        await readJson(request, 1048576),
      ),
    );
  } catch (e) {
    return errorResponse(e);
  }
}
