import "server-only";
import { AccessRepository } from "./access-repository";
import { sqlExecutor } from "./database";
import { createPinApi } from "./pin-api";
import { PinRepository } from "./pin-repository";
import { errorResponse } from "./http";
export async function pinAccess(
  request: Request,
  action: "users" | "login" | "manage",
) {
  try {
    const db = sqlExecutor();
    return await createPinApi({
      pins: new PinRepository(db),
      access: new AccessRepository(db),
      appUrl: process.env.APP_URL ?? "",
      secret: process.env.PIN_SECRET ?? "",
    })(request, action);
  } catch (e) {
    return errorResponse(e);
  }
}
