import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class SupplierError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SupplierInput {
  name: string;
  cpfCnpj?: string;
  contactName?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  notes?: string;
}

export async function listSuppliers(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const where = {
    active: true,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
            { cpfCnpj: { contains: q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.supplier.findMany({ where, orderBy: { name: "asc" }, skip: pageParams.skip, take: pageParams.take }),
    prisma.supplier.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function getSupplierDetail(id: string) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    include: { purchaseOrders: { orderBy: { createdAt: "desc" } } },
  });
  if (!supplier) throw new SupplierError("Fornecedor não encontrado.", 404);
  return supplier;
}

export async function createSupplier(input: SupplierInput) {
  return prisma.supplier.create({ data: input });
}

export async function updateSupplier(id: string, input: Partial<SupplierInput>) {
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) throw new SupplierError("Fornecedor não encontrado.", 404);
  return prisma.supplier.update({ where: { id }, data: input });
}

export async function archiveSupplier(id: string) {
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) throw new SupplierError("Fornecedor não encontrado.", 404);
  await prisma.supplier.update({ where: { id }, data: { active: false } });
}
