import { prisma } from "@/lib/prisma";

export class SectorError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SectorInput {
  name: string;
  storeId?: string;
}

const DEFAULT_SECTOR_NAMES = [
  "Pátio",
  "Funilaria",
  "Pintura",
  "Preparação",
  "Mecânica",
  "Desmontagem",
  "Montagem",
  "Lavagem",
  "Inspeção",
  "Aguardando peças",
  "Pronto para retirada",
  "Externo",
];

// Garante o catálogo padrão do SIGMA na primeira chamada (idempotente) — evita depender
// de rodar o seed.ts (que reseta todo o banco) só para ganhar os setores básicos.
export async function ensureDefaultSectors() {
  const count = await prisma.sector.count({ where: { isSystem: true } });
  if (count > 0) return;
  await prisma.sector.createMany({
    data: DEFAULT_SECTOR_NAMES.map((name) => ({ name, isSystem: true })),
  });
}

export async function listSectors(query: Record<string, unknown>) {
  await ensureDefaultSectors();
  const storeId = typeof query.storeId === "string" ? query.storeId : undefined;
  return prisma.sector.findMany({
    where: { active: true, ...(storeId ? { storeId } : {}) },
    orderBy: { name: "asc" },
  });
}

export async function createSector(input: SectorInput) {
  return prisma.sector.create({ data: input });
}

export async function updateSector(id: string, input: Partial<SectorInput> & { active?: boolean }) {
  const sector = await prisma.sector.findUnique({ where: { id } });
  if (!sector) throw new SectorError("Setor não encontrado.", 404);
  return prisma.sector.update({ where: { id }, data: input });
}

export async function archiveSector(id: string) {
  const sector = await prisma.sector.findUnique({ where: { id } });
  if (!sector) throw new SectorError("Setor não encontrado.", 404);
  if (sector.isSystem) throw new SectorError("Setores padrão do sistema não podem ser removidos.", 409);
  await prisma.sector.update({ where: { id }, data: { active: false } });
}
