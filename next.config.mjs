/** @type {import('next').NextConfig} */
const nextConfig = {
  // NOTE: Do NOT add "mysql2" to serverExternalPackages.
  // When mysql2 is treated as an external package, Next.js copies it into
  // .next/node_modules and relies on file tracing to bring along its transitive
  // deps. On some hosts (e.g. Hostinger/LiteSpeed) the tracer misses a nested
  // dependency — "sql-escaper" — and every DB route crashes at load with
  // "Cannot find module 'sql-escaper'". Letting Turbopack bundle mysql2 (pure JS,
  // no native bindings) inlines all of its dependencies and avoids the issue.
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
}

export default nextConfig
