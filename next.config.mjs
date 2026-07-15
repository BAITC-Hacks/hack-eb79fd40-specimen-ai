/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/**": ["./assets/fonts/**"],
  },
};
export default nextConfig;
