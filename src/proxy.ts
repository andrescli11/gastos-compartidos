import { NextResponse, type NextRequest } from "next/server";
import { contentSecurityPolicy, isPrivatePage } from "./server/security-policy";

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(
    crypto.getRandomValues(new Uint8Array(16)),
  ).toString("base64");
  const policy = contentSecurityPolicy(
    nonce,
    process.env.NODE_ENV === "development",
    request.nextUrl.protocol === "https:",
  );
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Next reads this request header and applies the nonce to its own scripts.
  headers.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (isPrivatePage(request.nextUrl.pathname)) {
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("Vercel-CDN-Cache-Control", "no-store");
    response.headers.set("CDN-Cache-Control", "no-store");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
