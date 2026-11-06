/** Values are generated per request; a client-supplied nonce is never trusted. */
export function contentSecurityPolicy(
  nonce: string,
  development: boolean,
  secureTransport: boolean,
) {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(nonce))
    throw new Error("Invalid security policy nonce.");
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    ...(secureTransport ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function isPrivatePage(pathname: string) {
  return (
    pathname === "/" ||
    /^\/(?:entrar|gastos|pagos|importar|administrar|api)(?:\/|$)/.test(pathname)
  );
}
