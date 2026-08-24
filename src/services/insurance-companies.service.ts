import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class InsuranceCompanyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface InsuranceCompanyInput {
  legalName: string;
  tradeName?: string;
  cnpj?: string;
  addressLine?: string;
  city?: string;
  state?: string;
  phone?: string;
  email?: string;
  contactName?: string;
  accredited?: boolean;
  notes?: string;
}

export async function listInsuranceCompanies(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const accreditedOnly = query.accredited === "true";

  const where = {
    active: true,
    ...(accreditedOnly ? { accredited: true } : {}),
    ...(q
      ? {
          OR: [
            { legalName: { contains: q, mode: "insensitive" as const } },
            { tradeName: { contains: q, mode: "insensitive" as const } },
            { cnpj: { contains: q } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.insuranceCompany.findMany({ where, orderBy: { legalName: "asc" }, skip: pageParams.skip, take: pageParams.take }),
    prisma.insuranceCompany.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function getInsuranceCompanyDetail(id: string) {
  const company = await prisma.insuranceCompany.findUnique({
    where: { id },
    include: { serviceOrders: { orderBy: { createdAt: "desc" }, take: 20 } },
  });
  if (!company) throw new InsuranceCompanyError("Seguradora não encontrada.", 404);
  return company;
}

export async function createInsuranceCompany(input: InsuranceCompanyInput) {
  return prisma.insuranceCompany.create({ data: input });
}

export async function updateInsuranceCompany(id: string, input: Partial<InsuranceCompanyInput>) {
  const company = await prisma.insuranceCompany.findUnique({ where: { id } });
  if (!company) throw new InsuranceCompanyError("Seguradora não encontrada.", 404);
  return prisma.insuranceCompany.update({ where: { id }, data: input });
}

export async function archiveInsuranceCompany(id: string) {
  const company = await prisma.insuranceCompany.findUnique({ where: { id } });
  if (!company) throw new InsuranceCompanyError("Seguradora não encontrada.", 404);
  await prisma.insuranceCompany.update({ where: { id }, data: { active: false } });
}
