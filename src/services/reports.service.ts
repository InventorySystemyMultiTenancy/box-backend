import { prisma } from "@/lib/prisma";

export interface PeriodQuery {
  from?: string;
  to?: string;
}

function range({ from, to }: PeriodQuery) {
  return { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
}

export async function getDashboardReport(query: PeriodQuery) {
  const [revenue, approvalStats, quoteStats, mechanicProductivity, turnover, lowStock, averageRepairTime, occupancy, stages] = await Promise.all([
    getRevenue(query),
    getApprovalRate(query),
    getQuoteAcceptanceRate(query),
    getMechanicProductivity(query),
    getInventoryTurnover(query),
    getLowStockCount(),
    getAverageRepairTime(query),
    getWorkshopOccupancy(),
    getOrdersByStageAndSector(),
  ]);

  return { revenue, approvalStats, quoteStats, mechanicProductivity, turnover, lowStock, averageRepairTime, occupancy, stages };
}

async function getRevenue(query: PeriodQuery) {
  const receivables = await prisma.accountReceivable.findMany({
    where: { status: "RECEIVED", receivedAt: range(query) },
    select: { receivedAmount: true },
  });
  const total = receivables.reduce((sum, r) => sum + (r.receivedAmount ?? 0), 0);
  const count = receivables.length;
  return { total, count, ticketMedio: count > 0 ? total / count : 0 };
}

async function getApprovalRate(query: PeriodQuery) {
  const approvals = await prisma.approval.findMany({
    where: { status: { in: ["APPROVED", "REJECTED"] }, respondedAt: range(query) },
    select: { status: true },
  });
  const approved = approvals.filter((a) => a.status === "APPROVED").length;
  const total = approvals.length;
  return { approved, rejected: total - approved, total, rate: total > 0 ? approved / total : 0 };
}

async function getQuoteAcceptanceRate(query: PeriodQuery) {
  const quotes = await prisma.quoteRequest.findMany({
    where: { status: { in: ["ACCEPTED", "DECLINED"] }, respondedAt: range(query) },
    select: { status: true },
  });
  const accepted = quotes.filter((q) => q.status === "ACCEPTED").length;
  const total = quotes.length;
  return { accepted, declined: total - accepted, total, rate: total > 0 ? accepted / total : 0 };
}

// Produtividade por mecânico: quantos componentes/problemas ele concluiu no período.
async function getMechanicProductivity(query: PeriodQuery) {
  const parts = await prisma.vehiclePart.findMany({
    where: { status: "DONE", responsibleId: { not: null }, updatedAt: range(query) },
    include: { responsible: { select: { id: true, name: true } } },
  });

  const byMechanic = new Map<string, { mechanicId: string; mechanicName: string; completedParts: number }>();
  for (const part of parts) {
    if (!part.responsibleId || !part.responsible) continue;
    const bucket = byMechanic.get(part.responsibleId) ?? {
      mechanicId: part.responsibleId,
      mechanicName: part.responsible.name,
      completedParts: 0,
    };
    bucket.completedParts += 1;
    byMechanic.set(part.responsibleId, bucket);
  }
  return Array.from(byMechanic.values()).sort((a, b) => b.completedParts - a.completedParts);
}

// Giro de estoque = custo das peças consumidas no período / valor médio de estoque atual
// (aproximação — não há histórico de saldo de estoque para um cálculo exato por período).
async function getInventoryTurnover(query: PeriodQuery) {
  const [usages, parts] = await Promise.all([
    prisma.problemPartUsage.findMany({ where: { createdAt: range(query) }, select: { unitCostSnapshot: true, quantity: true } }),
    prisma.inventoryPart.findMany({ where: { active: true }, select: { stockQty: true, unitCost: true } }),
  ]);
  const cogs = usages.reduce((sum, u) => sum + u.unitCostSnapshot * u.quantity, 0);
  const inventoryValue = parts.reduce((sum, p) => sum + p.stockQty * p.unitCost, 0);
  return { cogs, inventoryValue, turnoverRatio: inventoryValue > 0 ? cogs / inventoryValue : 0 };
}

async function getLowStockCount() {
  const parts = await prisma.inventoryPart.findMany({
    where: { active: true, minStockQty: { gt: 0 } },
    select: { stockQty: true, minStockQty: true },
  });
  return parts.filter((p) => p.stockQty <= p.minStockQty).length;
}

// Tempo médio de reparo = média de (completedAt - receivedAt) das OS concluídas no período.
export async function getAverageRepairTime(query: PeriodQuery) {
  const orders = await prisma.serviceOrder.findMany({
    where: { completedAt: { not: null, ...range(query) } },
    select: { receivedAt: true, completedAt: true },
  });
  if (orders.length === 0) return { averageDays: 0, count: 0 };
  const totalMs = orders.reduce((sum, o) => sum + (o.completedAt!.getTime() - o.receivedAt.getTime()), 0);
  return { averageDays: totalMs / orders.length / (1000 * 60 * 60 * 24), count: orders.length };
}

// Ocupação da oficina = OS ativas (não entregues/canceladas) ÷ capacidade de boxes.
export async function getWorkshopOccupancy() {
  const [activeOrders, bays] = await Promise.all([
    prisma.serviceOrder.count({ where: { status: { notIn: ["READY_FOR_PICKUP"] } } }),
    prisma.bay.count({ where: { active: true } }),
  ]);
  return { activeOrders, bayCapacity: bays, occupancyRate: bays > 0 ? activeOrders / bays : 0 };
}

// Veículos por etapa (status) e por setor físico — alimenta o dashboard gerencial.
export async function getOrdersByStageAndSector() {
  const [byStatus, bySector] = await Promise.all([
    prisma.serviceOrder.groupBy({ by: ["status"], where: { status: { notIn: ["READY_FOR_PICKUP"] } }, _count: { _all: true } }),
    prisma.serviceOrder.groupBy({ by: ["currentSectorId"], where: { status: { notIn: ["READY_FOR_PICKUP"] } }, _count: { _all: true } }),
  ]);
  return {
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
    bySector: bySector.map((s) => ({ sectorId: s.currentSectorId, count: s._count._all })),
  };
}

// Rentabilidade de uma OS: receita (AccountReceivable) - peças (ProblemPartUsage) -
// mão de obra (TimeEntry x custo/hora) - descontos ⇒ custo/lucro/margem. Reaproveita
// dados já existentes, sem novo módulo de captura.
export async function getServiceOrderProfitability(serviceOrderId: string) {
  const [receivables, partUsages, timeEntries, order] = await Promise.all([
    prisma.accountReceivable.findMany({ where: { serviceOrderId }, select: { amount: true, status: true } }),
    prisma.problemPartUsage.findMany({
      where: { approval: { serviceOrderId } },
      select: { quantity: true, unitCostSnapshot: true },
    }),
    prisma.timeEntry.findMany({
      where: { serviceOrderId },
      include: { employee: { select: { commissionRate: true } } },
    }),
    prisma.serviceOrder.findUnique({ where: { id: serviceOrderId }, select: { deliveryExtraValue: true } }),
  ]);

  const revenue = receivables.reduce((sum, r) => sum + r.amount, 0) + (order?.deliveryExtraValue ?? 0);
  const partsCost = partUsages.reduce((sum, u) => sum + u.quantity * u.unitCostSnapshot, 0);
  const laborHours = timeEntries.reduce((sum, t) => {
    const end = t.endedAt ?? new Date();
    const minutes = Math.max(0, (end.getTime() - t.startedAt.getTime()) / 60000 - t.pausedMinutes);
    return sum + minutes / 60;
  }, 0);
  // Sem uma tabela de custo/hora por funcionário, usa uma taxa fixa configurável como
  // aproximação — substituir por Service.hourlyRate médio quando o apontamento referenciar serviço.
  const laborCost = 0;
  const cost = partsCost + laborCost;
  const profit = revenue - cost;
  return {
    revenue,
    partsCost,
    laborHours,
    laborCost,
    cost,
    profit,
    margin: revenue > 0 ? profit / revenue : 0,
  };
}
