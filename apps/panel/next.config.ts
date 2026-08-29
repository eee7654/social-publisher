import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  allowedDevOrigins:[process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000']
};

export default nextConfig;
