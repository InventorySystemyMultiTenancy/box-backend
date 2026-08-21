import { prisma } from "@/lib/prisma";

export class BayError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface BayInput {
  name: string;
  type?: "BAY" | "LIFT";
  storeId?: string;
}

export async function listBays(storeId?: string) {
  return prisma.bay.findMany({ where: { active: true, ...(storeId ? { storeId } : {}) }, orderBy: { name: "asc" } });
}

export async function createBay(input: BayInput) {
  return prisma.bay.create({ data: input });
}

export async function updateBay(id: string, input: Partial<BayInput>) {
  const bay = await prisma.bay.findUnique({ where: { id } });
  if (!bay) throw new BayError("Box/elevador não encontrado.", 404);
  return prisma.bay.update({ where: { id }, data: input });
}

export async function archiveBay(id: string) {
  const bay = await prisma.bay.findUnique({ where: { id } });
  if (!bay) throw new BayError("Box/elevador não encontrado.", 404);
  await prisma.bay.update({ where: { id }, data: { active: false } });
}
