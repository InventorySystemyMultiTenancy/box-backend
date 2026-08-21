import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class ClientError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface ClientInput {
  name: string;
  cpfCnpj?: string;
  rg?: string;
  birthDate?: string;
  phone?: string;
  whatsapp?: string;
  email?: string;
  addressLine?: string;
  zipCode?: string;
  city?: string;
  state?: string;
  company?: string;
  clientType?: "INDIVIDUAL" | "COMPANY";
  notes?: string;
  internalNotes?: string;
  userId?: string;
}

function toData(input: Partial<ClientInput>) {
  return {
    ...input,
    birthDate: input.birthDate ? new Date(input.birthDate) : input.birthDate === "" ? null : undefined,
  };
}

export async function listClients(query: Record<string, unknown>) {
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
            { whatsapp: { contains: q } },
            { cpfCnpj: { contains: q } },
            { user: { vehicles: { some: { plate: { contains: q, mode: "insensitive" as const } } } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { name: "asc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.client.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function getClientDetail(id: string) {
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      // select (não include) — nunca trazer passwordHash do User para a resposta da API.
      user: {
        select: {
          vehicles: {
            include: {
              serviceOrders: { orderBy: { createdAt: "desc" } },
              quoteRequests: { orderBy: { createdAt: "desc" } },
            },
          },
        },
      },
    },
  });
  if (!client) throw new ClientError("Cliente não encontrado.", 404);

  const serviceOrders = client.user?.vehicles.flatMap((v) => v.serviceOrders) ?? [];
  const quoteRequests = client.user?.vehicles.flatMap((v) => v.quoteRequests) ?? [];

  const orderIds = serviceOrders.map((o) => o.id);
  const totalSpentResult = orderIds.length
    ? await prisma.financialEntry.aggregate({
        where: { serviceOrderId: { in: orderIds }, type: "INCOME" },
        _sum: { amount: true },
      })
    : null;

  const lastVisit = serviceOrders
    .map((o) => o.completedAt ?? o.receivedAt)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const { user: _user, ...clientFields } = client;
  return {
    ...clientFields,
    vehicles: client.user?.vehicles.map(({ serviceOrders: _so, quoteRequests: _qr, ...v }) => v) ?? [],
    serviceOrders,
    quoteRequests,
    totalSpent: totalSpentResult?._sum.amount ?? 0,
    lastVisit: lastVisit ?? null,
  };
}

export async function createClient(input: ClientInput) {
  if (input.userId) {
    const existing = await prisma.client.findUnique({ where: { userId: input.userId } });
    if (existing) throw new ClientError("Este usuário já possui um cadastro de cliente.", 409);
  }
  return prisma.client.create({ data: toData(input) as never });
}

export async function updateClient(id: string, input: Partial<ClientInput>) {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) throw new ClientError("Cliente não encontrado.", 404);
  return prisma.client.update({ where: { id }, data: toData(input) as never });
}

export async function archiveClient(id: string) {
  const client = await prisma.client.findUnique({ where: { id } });
  if (!client) throw new ClientError("Cliente não encontrado.", 404);
  await prisma.client.update({ where: { id }, data: { active: false } });
}

// Usado pela leitura de nota fiscal por IA: casa o destinatário identificado na imagem
// com um cliente já cadastrado (por CPF/CNPJ, depois por nome exato) ou cadastra um novo
// automaticamente com os dados extraídos, para o usuário só confirmar no formulário.
export async function findOrCreateClientFromDocument(name?: string | null, cpfCnpj?: string | null) {
  const cleanName = name?.trim();
  const cleanDoc = cpfCnpj?.trim();
  if (!cleanName && !cleanDoc) return { client: null, created: false };

  if (cleanDoc) {
    const byDoc = await prisma.client.findFirst({ where: { cpfCnpj: cleanDoc } });
    if (byDoc) return { client: byDoc, created: false };
  }
  if (cleanName) {
    const byName = await prisma.client.findFirst({ where: { name: { equals: cleanName, mode: "insensitive" } } });
    if (byName) return { client: byName, created: false };
  }
  if (!cleanName) return { client: null, created: false };

  const created = await prisma.client.create({
    data: {
      name: cleanName,
      cpfCnpj: cleanDoc || undefined,
      clientType: cleanDoc && cleanDoc.replace(/\D/g, "").length > 11 ? "COMPANY" : "INDIVIDUAL",
      internalNotes: "Cadastrado automaticamente a partir da leitura de nota fiscal por IA — confira os dados.",
    },
  });
  return { client: created, created: true };
}
