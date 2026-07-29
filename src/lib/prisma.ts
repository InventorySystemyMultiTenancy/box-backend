import { PrismaClient } from "@prisma/client";

// Evita múltiplas instâncias do client em hot-reload de dev (tsx watch).
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma = global.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__prisma = prisma;
}
