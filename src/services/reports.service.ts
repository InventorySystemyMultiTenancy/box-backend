import { prisma } from "@/lib/prisma";

export interface PeriodQuery {
  from?: string;
  to?: string;
}

function range({ from, to }: PeriodQuery) {
  return { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) };
}

export async function getDashboardReport(query: PeriodQuery) {
  const [revenue, approvalStats, quoteStats, mechanicProductivity, turnover, lowStock] = await Promise.all([
    getRevenue(query),
    getApprovalRate(query),
    getQuoteAcceptanceRate(query),
    getMechanicProductivity(query),
    getInventoryTurnover(query),
    getLowStockCount(),
  ]);

  return { revenue, approvalStats, quoteStats, mechanicProductivity, turnover, lowStock };
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
