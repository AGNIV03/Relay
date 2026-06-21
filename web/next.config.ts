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
};

export default nextConfig;
