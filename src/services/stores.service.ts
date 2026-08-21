import { prisma } from "@/lib/prisma";

export class StoreError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface StoreInput {
  name: string;
  addressLine?: string;
  city?: string;
  state?: string;
  phone?: string;
}

export async function listStores() {
  return prisma.store.findMany({ where: { active: true }, orderBy: { name: "asc" } });
}

export async function createStore(input: StoreInput) {
  return prisma.store.create({ data: input });
}

export async function updateStore(id: string, input: Partial<StoreInput>) {
  const store = await prisma.store.findUnique({ where: { id } });
  if (!store) throw new StoreError("Loja não encontrada.", 404);
  return prisma.store.update({ where: { id }, data: input });
}

export async function archiveStore(id: string) {
  const store = await prisma.store.findUnique({ where: { id } });
  if (!store) throw new StoreError("Loja não encontrada.", 404);
  await prisma.store.update({ where: { id }, data: { active: false } });
}
