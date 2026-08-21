import { prisma } from "@/lib/prisma";

export interface PeriodQuery {
  from?: string;
  to?: string;
}

function periodWhere(field: "receivedAt" | "paidAt", { from, to }: PeriodQuery) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } };
}

// Fluxo de caixa realizado: soma de contas recebidas (entradas) e pagas (saídas)
// no período, mais o saldo inicial de todas as contas bancárias ativas.
export async function getCashFlow(query: PeriodQuery) {
  const [receivedEntries, paidEntries, bankAccounts] = await Promise.all([
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", ...periodWhere("receivedAt", query) },
      select: { receivedAt: true, receivedAmount: true, category: true },
    }),
    prisma.accountPayable.findMany({
      where: { status: "PAID", ...periodWhere("paidAt", query) },
      select: { paidAt: true, paidAmount: true, category: true },
    }),
    prisma.bankAccount.findMany({ where: { active: true }, select: { initialBalance: true } }),
  ]);

  const totalIn = receivedEntries.reduce((sum, e) => sum + (e.receivedAmount ?? 0), 0);
  const totalOut = paidEntries.reduce((sum, e) => sum + (e.paidAmount ?? 0), 0);
  const initialBalance = bankAccounts.reduce((sum, a) => sum + a.initialBalance, 0);

  const byDay = new Map<string, { date: string; in: number; out: number }>();
  for (const e of receivedEntries) {
    const day = (e.receivedAt as Date).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { date: day, in: 0, out: 0 };
    bucket.in += e.receivedAmount ?? 0;
    byDay.set(day, bucket);
  }
  for (const e of paidEntries) {
    const day = (e.paidAt as Date).toISOString().slice(0, 10);
    const bucket = byDay.get(day) ?? { date: day, in: 0, out: 0 };
    bucket.out += e.paidAmount ?? 0;
    byDay.set(day, bucket);
  }

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
  };
}

// DRE simplificado: receita bruta (recebido) menos despesas (pago), agrupado por categoria.
export async function getDRE(query: PeriodQuery) {
  const [receivedEntries, paidEntries] = await Promise.all([
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", ...periodWhere("receivedAt", query) },
      select: { receivedAmount: true, category: true },
    }),
    prisma.accountPayable.findMany({
      where: { status: "PAID", ...periodWhere("paidAt", query) },
      select: { paidAmount: true, category: true },
    }),
  ]);

  const revenueByCategory = groupSum(receivedEntries, "receivedAmount");
  const expensesByCategory = groupSum(paidEntries, "paidAmount");

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

function groupSum<T extends { category: string }>(rows: T[], amountKey: keyof T) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const amount = (row[amountKey] as number | null) ?? 0;
    map.set(row.category, (map.get(row.category) ?? 0) + amount);
  }
  return Array.from(map.entries()).map(([category, amount]) => ({ category, amount }));
}

function sumValues(rows: { amount: number }[]) {
  return rows.reduce((sum, r) => sum + r.amount, 0);
}
