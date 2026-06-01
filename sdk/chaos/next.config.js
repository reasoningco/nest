/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client", "jira.js"],
  },
  reactStrictMode: true,
  // output: "standalone" is only needed when building for the Docker image.
  ...(process.env.NEXT_STANDALONE ? { output: "standalone" } : {}),
};

module.exports = nextConfig;
