import { prisma } from "@/lib/prisma";
import { LEGACY_ORDER_INCOME_CATEGORIES, roundMoney } from "@/services/finance-rules";
import { dropDuplicatedOrderIncome } from "@/services/service-order-billing.service";

export interface PeriodQuery {
  from?: string;
  to?: string;
}

function range({ from, to }: PeriodQuery) {
  return { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
}

export async function getDashboardReport(query: PeriodQuery) {
  const [revenue, approvalStats, quoteStats, mechanicProductivity, partsUsage, averageRepairTime, occupancy, stages] = await Promise.all([
    getRevenue(query),
    getApprovalRate(query),
    getQuoteAcceptanceRate(query),
    getMechanicProductivity(query),
    getPartsUsage(query),
    getAverageRepairTime(query),
    getWorkshopOccupancy(),
    getOrdersByStageAndSector(),
  ]);

  return { revenue, approvalStats, quoteStats, mechanicProductivity, partsUsage, averageRepairTime, occupancy, stages };
}

// Faturamento recebido no período: contas a receber baixadas + receita de OS lançada do
// jeito antigo (sem duplicar com conta a receber). Ticket médio é por OS/venda, não por
// parcela — uma OS em 3x conta como um atendimento só.
async function getRevenue(query: PeriodQuery) {
  const [receivables, legacyEntries] = await Promise.all([
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", receivedAt: range(query) },
      select: { id: true, receivedAmount: true, amount: true, serviceOrderId: true, groupId: true },
    }),
    prisma.financialEntry
      .findMany({
        where: { type: "INCOME", category: { in: [...LEGACY_ORDER_INCOME_CATEGORIES] }, occurredAt: range(query) },
        select: { type: true, category: true, serviceOrderId: true, amount: true },
      })
      .then(dropDuplicatedOrderIncome),
  ]);
  const total = roundMoney(
    receivables.reduce((sum, r) => sum + (r.receivedAmount ?? r.amount), 0) + legacyEntries.reduce((sum, e) => sum + e.amount, 0)
  );
  const attendances = new Set([
    ...receivables.map((r) => r.serviceOrderId ?? r.groupId ?? r.id),
    ...legacyEntries.map((e) => e.serviceOrderId!),
  ]);
  const count = attendances.size;
  return { total, count, ticketMedio: count > 0 ? roundMoney(total / count) : 0 };
}

/**
 * Indicadores do topo do painel (admin): faturamento recebido no mês, OS entregues e ticket
 * médio do que foi entregue, tempo médio de reparo, OS em andamento por etapa e o que
 * está a receber (em aberto e vencido).
 */
export async function getHomeKpis() {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const month = { from: monthStart.toISOString(), to: now.toISOString() };

  const [revenue, repairTime, delivered, activeByStatus, openReceivables] = await Promise.all([
    getRevenue(month),
    getAverageRepairTime(month),
    prisma.serviceOrder.findMany({
      where: { completedAt: { gte: monthStart, lte: now } },
      select: {
        id: true,
        accountsReceivable: { where: { status: { not: "CANCELLED" } }, select: { amount: true } },
        financialEntries: { where: { type: "INCOME", category: { in: [...LEGACY_ORDER_INCOME_CATEGORIES] } }, select: { amount: true } },
      },
    }),
    prisma.serviceOrder.groupBy({
      by: ["status"],
      where: { archivedAt: null, status: { not: "READY_FOR_PICKUP" } },
      _count: { _all: true },
    }),
    prisma.accountReceivable.findMany({
      where: { status: { in: ["PENDING", "OVERDUE"] } },
      select: { amount: true, dueDate: true },
    }),
  ]);

  const billedDelivered = delivered.reduce((sum, o) => {
    const billed = o.accountsReceivable.length > 0 ? o.accountsReceivable : o.financialEntries;
    return sum + billed.reduce((s, r) => s + r.amount, 0);
  }, 0);

  return {
    monthRevenue: revenue.total,
    deliveredCount: delivered.length,
    deliveredBilled: roundMoney(billedDelivered),
    averageTicket: delivered.length > 0 ? roundMoney(billedDelivered / delivered.length) : 0,
    averageRepairDays: repairTime.averageDays,
    activeOrders: activeByStatus.reduce((sum, s) => sum + s._count._all, 0),
    byStatus: activeByStatus.map((s) => ({ status: s.status, count: s._count._all })),
    receivableOpen: roundMoney(openReceivables.reduce((sum, r) => sum + r.amount, 0)),
    receivableOverdue: roundMoney(openReceivables.filter((r) => r.dueDate < now).reduce((sum, r) => sum + r.amount, 0)),
  };
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

// Peças usadas em projetos no período (problemas não reprovados) — valor total e as mais
// usadas. Substitui o antigo "giro de estoque", já que não há mais controle de estoque.
async function getPartsUsage(query: PeriodQuery) {
  const usages = await prisma.problemPartUsage.findMany({
    where: { createdAt: range(query), approval: { status: { not: "REJECTED" } } },
    select: { quantity: true, unitCostSnapshot: true, inventoryPart: { select: { id: true, name: true } } },
  });
  const byPart = new Map<string, { partId: string; name: string; quantity: number; value: number }>();
  for (const u of usages) {
    const row = byPart.get(u.inventoryPart.id) ?? { partId: u.inventoryPart.id, name: u.inventoryPart.name, quantity: 0, value: 0 };
    row.quantity += u.quantity;
    row.value = roundMoney(row.value + u.quantity * u.unitCostSnapshot);
    byPart.set(u.inventoryPart.id, row);
  }
  const top = [...byPart.values()].sort((a, b) => b.quantity - a.quantity);
  return {
    totalValue: roundMoney(top.reduce((sum, p) => sum + p.value, 0)),
    totalQuantity: top.reduce((sum, p) => sum + p.quantity, 0),
    topParts: top.slice(0, 10),
  };
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
  const [receivables, partUsages, timeEntries, legacyIncome] = await Promise.all([
    prisma.accountReceivable.findMany({ where: { serviceOrderId, status: { not: "CANCELLED" } }, select: { amount: true, status: true } }),
    prisma.problemPartUsage.findMany({
      where: { approval: { serviceOrderId, status: { not: "REJECTED" } } },
      select: { quantity: true, unitCostSnapshot: true },
    }),
    prisma.timeEntry.findMany({
      where: { serviceOrderId },
      include: { employee: { select: { commissionRate: true } } },
    }),
    prisma.financialEntry.findMany({
      where: { serviceOrderId, type: "INCOME", category: { in: [...LEGACY_ORDER_INCOME_CATEGORIES] } },
      select: { amount: true },
    }),
  ]);

  // A cobrança da OS (já com o valor extra da entrega) está nas contas a receber; OS
  // antigas, cobradas antes disso, só têm o lançamento de receita da entrega.
  const revenue =
    receivables.length > 0 ? receivables.reduce((sum, r) => sum + r.amount, 0) : legacyIncome.reduce((sum, e) => sum + e.amount, 0);
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
