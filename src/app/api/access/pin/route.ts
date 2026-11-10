import { pinAccess } from "@/server/pin-access";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return pinAccess(request, "login");
}
