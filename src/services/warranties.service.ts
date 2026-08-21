import { prisma } from "@/lib/prisma";

export class WarrantyError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function setPartWarranty(orderId: string, partId: string, months: number, startAt?: string) {
  const part = await prisma.vehiclePart.findUnique({ where: { id: partId } });
  if (!part || part.serviceOrderId !== orderId) throw new WarrantyError("Peça/componente não encontrado nesta OS.", 404);

  const warrantyStartAt = startAt ? new Date(startAt) : new Date();
  const warrantyExpiresAt = new Date(warrantyStartAt);
  warrantyExpiresAt.setMonth(warrantyExpiresAt.getMonth() + months);

  return prisma.vehiclePart.update({
    where: { id: partId },
    data: {
      warrantyMonths: months,
      warrantyStartAt,
      warrantyExpiresAt,
      warranty: `${months} meses`,
    },
  });
}

// Peças com garantia vencendo dentro de `withinDays` (inclui já vencidas, para follow-up).
export async function listExpiringWarranties(withinDays: number) {
  const limit = new Date();
  limit.setDate(limit.getDate() + withinDays);

  return prisma.vehiclePart.findMany({
    where: { warrantyExpiresAt: { not: null, lte: limit } },
    include: {
      serviceOrder: { include: { vehicle: { include: { owner: { select: { id: true, name: true, phone: true } } } } } },
    },
    orderBy: { warrantyExpiresAt: "asc" },
  });
}
