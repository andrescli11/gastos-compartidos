import { pinAccess } from "@/server/pin-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return pinAccess(request, "users");
}
