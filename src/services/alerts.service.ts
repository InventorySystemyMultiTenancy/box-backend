import { prisma } from "@/lib/prisma";
import { STALE_STATUS_ALERT_DAYS, SUPPLEMENT_PENDING_ALERT_DAYS } from "@/lib/constants";

interface AlertCandidate {
  type: string;
  entity: string;
  entityId: string;
  message: string;
}

async function computeCandidates(): Promise<AlertCandidate[]> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_STATUS_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const supplementThreshold = new Date(now.getTime() - SUPPLEMENT_PENDING_ALERT_DAYS * 24 * 60 * 60 * 1000);
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);
  const tomorrowStart = new Date(now);
  tomorrowStart.setDate(now.getDate() + 1);
  tomorrowStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(tomorrowStart);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const [staleOrders, pendingSupplements, lowStockParts, inspectionsToday, deliveriesTomorrow] = await Promise.all([
    prisma.serviceOrder.findMany({
      where: { status: { notIn: ["READY_FOR_PICKUP"] }, updatedAt: { lte: staleThreshold } },
      include: { vehicle: true },
    }),
    prisma.approval.findMany({
      where: { kind: "SUPPLEMENT", status: "PENDING", createdAt: { lte: supplementThreshold } },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.inventoryPart.findMany({ where: { active: true, minStockQty: { gt: 0 } } }),
    prisma.inspection.findMany({
      where: { status: "SCHEDULED", scheduledAt: { gte: todayStart, lte: todayEnd } },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.serviceOrder.findMany({
      where: { deliveryForecastAt: { gte: tomorrowStart, lte: tomorrowEnd }, status: { notIn: ["READY_FOR_PICKUP"] } },
      include: { vehicle: true },
    }),
  ]);

  const candidates: AlertCandidate[] = [];

  for (const order of staleOrders) {
    const days = Math.floor((Date.now() - order.updatedAt.getTime()) / (1000 * 60 * 60 * 24));
    candidates.push({
      type: "STALE_STATUS",
      entity: "ServiceOrder",
      entityId: order.id,
      message: `Veículo ${order.vehicle.plate ?? order.vehicle.model} está há ${days} dias sem mudança de status (${order.code}).`,
    });
  }
  for (const approval of pendingSupplements) {
    const days = Math.floor((Date.now() - approval.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    candidates.push({
      type: "SUPPLEMENT_PENDING",
      entity: "Approval",
      entityId: approval.id,
      message: `Complemento pendente há ${days} dias — ${approval.serviceOrder.code} (${approval.serviceOrder.vehicle.plate ?? approval.serviceOrder.vehicle.model}).`,
    });
  }
  for (const part of lowStockParts.filter((p) => p.stockQty <= p.minStockQty)) {
    candidates.push({
      type: "LOW_STOCK",
      entity: "InventoryPart",
      entityId: part.id,
      message: `Estoque de ${part.name} abaixo do mínimo (${part.stockQty}/${part.minStockQty}).`,
    });
  }
  for (const inspection of inspectionsToday) {
    candidates.push({
      type: "INSPECTION_TODAY",
      entity: "Inspection",
      entityId: inspection.id,
      message: `Vistoria marcada para hoje — ${inspection.serviceOrder.code} (${inspection.serviceOrder.vehicle.plate ?? inspection.serviceOrder.vehicle.model}).`,
    });
  }
  for (const order of deliveriesTomorrow) {
    candidates.push({
      type: "DELIVERY_TOMORROW",
      entity: "ServiceOrder",
      entityId: order.id,
      message: `Entrega prevista para amanhã — ${order.code} (${order.vehicle.plate ?? order.vehicle.model}).`,
    });
  }

  return candidates;
}

// Gera notificações a partir das regras, evitando duplicar uma já existente e não
// lida para o mesmo tipo+entidade. Chamado sob demanda (GET /api/alerts), sem
// depender de um job/cron (não há infraestrutura de background job no projeto).
export async function refreshAlerts() {
  const candidates = await computeCandidates();

  for (const candidate of candidates) {
    const existing = await prisma.notification.findFirst({
      where: { type: candidate.type, entity: candidate.entity, entityId: candidate.entityId, read: false },
    });
    if (existing) {
      if (existing.message !== candidate.message) {
        await prisma.notification.update({ where: { id: existing.id }, data: { message: candidate.message } });
      }
      continue;
    }
    await prisma.notification.create({ data: candidate });
  }

  return prisma.notification.findMany({ where: { read: false }, orderBy: { createdAt: "desc" } });
}

export async function markAlertRead(id: string) {
  return prisma.notification.update({ where: { id }, data: { read: true } });
}
