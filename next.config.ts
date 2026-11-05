import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      ...(process.env.NODE_ENV==='production' ? [{key:'Strict-Transport-Security',value:'max-age=31536000'}] : []),
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '') + "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
    ] },{source:'/gastos/:path*',headers:[{key:'Cache-Control',value:'private, no-store, max-age=0'}]},{source:'/entrar/:path*',headers:[{key:'Cache-Control',value:'private, no-store, max-age=0'}]}];
  },
};
export default nextConfig;
