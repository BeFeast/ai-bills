import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['@openai/codex', 'ws', 'postgres'],
};

export default nextConfig;
