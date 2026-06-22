import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a slim standalone server for the Docker image.
  output: "standalone",
  reactStrictMode: true,
  experimental: {
    // Next 15.5 caps the body of proxied (rewritten) requests at 10MB by default,
    // which truncates large lossless audio uploads going through the /api proxy
    // below (the backend then sees a short body → socket hang up → 500). Raise it
    // to match the API's own 2GB multer limit so full songs upload intact.
    middlewareClientMaxBodySize: "2gb",
  },
  // Same-origin API proxy. Lets the browser call /api/* on whatever host/scheme
  // serves the web app (e.g. https://music.agniv.site/api/...) and forwards it
  // to the API container over the internal Docker network — avoiding mixed-content
  // (HTTPS page → HTTP API) and CORS entirely. Only the web container makes the
  // internal hop. Override the target with API_PROXY_TARGET if the API isn't the
  // compose "server" service.
  async rewrites() {
    const target = process.env.API_PROXY_TARGET || "http://server:4000";
    return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
  },

  // Security headers applied to every response. CSP is same-origin only (the app
  // talks to /api on its own origin via the proxy above, and loads audio/cover art
  // from there too). 'unsafe-inline'/'unsafe-eval' are required by Next.js's
  // runtime + Tailwind's inline styles.
  async headers() {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
      "upgrade-insecure-requests",
    ].join("; ");
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
