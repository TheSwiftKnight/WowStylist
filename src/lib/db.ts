import { PrismaClient } from "@prisma/client";

// Next.js dev 模式會熱重載，避免每次重載都 new 一個連線
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
