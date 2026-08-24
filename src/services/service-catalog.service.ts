import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class ServiceCatalogError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface ServiceCatalogInput {
  code?: string;
  category?: string;
  name: string;
  description?: string;
  standardTimeMin?: number;
  hourlyRate?: number;
  standardPrice?: number;
  sector?: string;
}

export async function listServiceCatalog(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const where = {
    active: true,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { category: { contains: q, mode: "insensitive" as const } },
            { code: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.service.findMany({ where, orderBy: { name: "asc" }, skip: pageParams.skip, take: pageParams.take }),
    prisma.service.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function createServiceCatalogItem(input: ServiceCatalogInput) {
  return prisma.service.create({ data: input });
}

export async function updateServiceCatalogItem(id: string, input: Partial<ServiceCatalogInput> & { active?: boolean }) {
  const item = await prisma.service.findUnique({ where: { id } });
  if (!item) throw new ServiceCatalogError("Serviço não encontrado.", 404);
  return prisma.service.update({ where: { id }, data: input });
}

export async function archiveServiceCatalogItem(id: string) {
  const item = await prisma.service.findUnique({ where: { id } });
  if (!item) throw new ServiceCatalogError("Serviço não encontrado.", 404);
  await prisma.service.update({ where: { id }, data: { active: false } });
}
