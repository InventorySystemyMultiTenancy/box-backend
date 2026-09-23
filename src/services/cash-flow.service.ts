import { prisma } from "@/lib/prisma";

export interface PeriodQuery {
  from?: string;
  to?: string;
}

// Venda de balcão (PDV) já lança a margem como FinancialEntry "LUCRO_PDV" (ver
// counter-sales.service.ts) — mas a receita cheia da venda já está na conta a
// receber categoria "PDV", então essa margem não entra de novo aqui.
const PDV_PROFIT_CATEGORY = "LUCRO_PDV";
// Custo de peça em projeto vem fresco de ProblemPartUsage (loadPartsCost) — o
// FinancialEntry "PEÇA" (fluxo antigo de aprovação do cliente) não entra de novo.
const PART_COST_CATEGORY = "PEÇA";
const PARTS_COST_LABEL = "Peças em projetos";

function periodWhere(field: string, { from, to }: PeriodQuery) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } };
}

// Mesmo custo real de peças usado no Resumo (/finance/summary) — problemas
// reprovados não contam, o resto sim, datado pelo momento em que a peça foi
// registrada no problema (não depende de aprovação do cliente).
async function loadPartsCost(query: PeriodQuery) {
  const usages = await prisma.problemPartUsage.findMany({
    where: { approval: { status: { not: "REJECTED" } }, ...periodWhere("createdAt", query) },
    select: { quantity: true, unitCostSnapshot: true, createdAt: true },
  });
  return usages.map((u) => ({ date: u.createdAt, amount: u.unitCostSnapshot * u.quantity }));
}

// Fluxo de caixa realizado: soma de contas recebidas/pagas, lançamentos manuais e
// custo de peças no período, mais o saldo inicial de todas as contas bancárias
// ativas. Retorna também os registros brutos do período (editáveis pela própria
// aba — ver rotas PATCH em accounts-payable/accounts-receivable/finance).
export async function getCashFlow(query: PeriodQuery) {
  const [receivables, payables, financialEntries, partUsages, bankAccounts] = await Promise.all([
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", ...periodWhere("receivedAt", query) },
      include: { client: { select: { id: true, name: true } }, serviceOrder: { select: { id: true, code: true } } },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.accountPayable.findMany({
      where: { status: "PAID", ...periodWhere("paidAt", query) },
      orderBy: { paidAt: "asc" },
    }),
    prisma.financialEntry.findMany({
      where: periodWhere("occurredAt", query),
      orderBy: { occurredAt: "asc" },
    }),
    loadPartsCost(query),
    prisma.bankAccount.findMany({ where: { active: true }, select: { initialBalance: true } }),
  ]);

  const incomeEntries = financialEntries.filter((e) => e.type === "INCOME" && e.category !== PDV_PROFIT_CATEGORY);
  const expenseEntries = financialEntries.filter((e) => e.type === "EXPENSE" && e.category !== PART_COST_CATEGORY);
  const partsCostTotal = partUsages.reduce((sum, u) => sum + u.amount, 0);

  const totalIn = receivables.reduce((sum, r) => sum + (r.receivedAmount ?? 0), 0) + incomeEntries.reduce((sum, e) => sum + e.amount, 0);
  const totalOut =
    payables.reduce((sum, p) => sum + (p.paidAmount ?? p.amount), 0) +
    expenseEntries.reduce((sum, e) => sum + e.amount, 0) +
    partsCostTotal;
  const initialBalance = bankAccounts.reduce((sum, a) => sum + a.initialBalance, 0);

  const byDay = new Map<string, { date: string; in: number; out: number }>();
  function bucketFor(date: Date) {
    const day = date.toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { date: day, in: 0, out: 0 };
    byDay.set(day, bucket);
    return bucket;
  }

  for (const r of receivables) if (r.receivedAt) bucketFor(r.receivedAt).in += r.receivedAmount ?? 0;
  for (const e of incomeEntries) bucketFor(e.occurredAt).in += e.amount;
  for (const p of payables) if (p.paidAt) bucketFor(p.paidAt).out += p.paidAmount ?? p.amount;
  for (const e of expenseEntries) bucketFor(e.occurredAt).out += e.amount;
  for (const u of partUsages) bucketFor(u.date).out += u.amount;

  const timeline = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
  let running = initialBalance;
  const timelineWithBalance = timeline.map((bucket) => {
    running += bucket.in - bucket.out;
    return { ...bucket, balance: running };
  });

  return {
    initialBalance,
    totalIn,
    totalOut,
    finalBalance: initialBalance + totalIn - totalOut,
    timeline: timelineWithBalance,
    partsCost: partsCostTotal,
    receivables,
    payables,
    entries: financialEntries,
  };
}

// DRE simplificado: mesmas três fontes do fluxo de caixa (contas recebidas/pagas +
// lançamentos manuais + custo de peças), agrupadas por categoria.
export async function getDRE(query: PeriodQuery) {
  const [receivables, payables, financialEntries, partUsages] = await Promise.all([
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", ...periodWhere("receivedAt", query) },
      select: { receivedAmount: true, category: true },
    }),
    prisma.accountPayable.findMany({
      where: { status: "PAID", ...periodWhere("paidAt", query) },
      select: { paidAmount: true, amount: true, category: true },
    }),
    prisma.financialEntry.findMany({
      where: periodWhere("occurredAt", query),
      select: { type: true, amount: true, category: true },
    }),
    loadPartsCost(query),
  ]);

  const revenueRows = [
    ...receivables.map((r) => ({ category: r.category, amount: r.receivedAmount ?? 0 })),
    ...financialEntries.filter((e) => e.type === "INCOME" && e.category !== PDV_PROFIT_CATEGORY).map((e) => ({ category: e.category, amount: e.amount })),
  ];
  const expenseRows = [
    ...payables.map((p) => ({ category: p.category, amount: p.paidAmount ?? p.amount })),
    ...financialEntries
      .filter((e) => e.type === "EXPENSE" && e.category !== PART_COST_CATEGORY)
      .map((e) => ({ category: e.category, amount: e.amount })),
  ];
  const partsCostTotal = partUsages.reduce((sum, u) => sum + u.amount, 0);
  if (partsCostTotal > 0) expenseRows.push({ category: PARTS_COST_LABEL, amount: partsCostTotal });

  const revenueByCategory = groupSum(revenueRows);
  const expensesByCategory = groupSum(expenseRows);
  const grossRevenue = sumValues(revenueByCategory);
  const totalExpenses = sumValues(expensesByCategory);

  return {
    grossRevenue,
    totalExpenses,
    netResult: grossRevenue - totalExpenses,
    revenueByCategory,
    expensesByCategory,
  };
}

function groupSum(rows: { category: string; amount: number }[]) {
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.category, (map.get(row.category) ?? 0) + row.amount);
  }
  return Array.from(map.entries()).map(([category, amount]) => ({ category, amount }));
}

function sumValues(rows: { amount: number }[]) {
  return rows.reduce((sum, r) => sum + r.amount, 0);
}
