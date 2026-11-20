import { PrismaClient } from "@prisma/client";

declare global {
  var prisma: PrismaClient | undefined;
}

export const prisma = global.prisma || new PrismaClient();

// Reutilise aussi en prod (20/11) : une instance chaude garde sa connexion.
global.prisma = prisma;
