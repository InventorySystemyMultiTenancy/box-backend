import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { getCashFlow, getDRE } from "@/services/cash-flow.service";

export const financeRouter = Router();

financeRouter.get("/cash-flow", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  const cashFlow = await getCashFlow(req.query as { from?: string; to?: string });
  res.json({ cashFlow });
});

financeRouter.get("/dre", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  const dre = await getDRE(req.query as { from?: string; to?: string });
  res.json({ dre });
});

function monthKey(date: Date) {
  return date.toISOString().slice(0, 7);
}

// Venda de balcão (PDV) já lança a margem como FinancialEntry "LUCRO_PDV" — a receita
// cheia da venda entra à parte, pela conta a receber categoria "PDV" (ver ponto abaixo).
// Contar as duas contaria a mesma venda duas vezes.
const PDV_PROFIT_CATEGORY = "LUCRO_PDV";
const PART_COST_CATEGORY = "PEÇA";

function periodWhere(field: string, from?: string, to?: string) {
  if (!from && !to) return {};
  return { [field]: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } };
}

financeRouter.get("/summary", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;

  const [entries, partUsages, paidPayables, receivedReceivables] = await Promise.all([
    prisma.financialEntry.findMany({
      where: periodWhere("occurredAt", from, to),
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: { occurredAt: "desc" },
    }),
    // Custo real de peças gastas em projetos — direto do uso registrado (não depende
    // mais do fluxo (hoje raro) de aprovação do cliente que gerava um FinancialEntry
    // "PEÇA" à parte; problemas reprovados não contam, o resto sim.
    prisma.problemPartUsage.findMany({
      where: { approval: { status: { not: "REJECTED" } }, ...periodWhere("createdAt", from, to) },
      select: { quantity: true, unitCostSnapshot: true, createdAt: true },
    }),
    // Toda conta a pagar já paga é saída de caixa: compra de peça para estoque, boleto
    // de nota fiscal, comissão paga, despesa fixa lançada em contas a pagar, etc.
    prisma.accountPayable.findMany({
      where: { status: "PAID", ...periodWhere("paidAt", from, to) },
      select: { amount: true, paidAmount: true, paidAt: true, updatedAt: true },
    }),
    // Conta a receber recebida também é entrada — mesma regra já usada no fluxo de
    // caixa/DRE (getCashFlow/getDRE), replicada aqui pra Resumo e Fluxo de caixa
    // baterem os mesmos totais.
    prisma.accountReceivable.findMany({
      where: { status: "RECEIVED", ...periodWhere("receivedAt", from, to) },
      select: { amount: true, receivedAmount: true, receivedAt: true, updatedAt: true },
    }),
  ]);

  const incomeEntries = entries.filter((e) => e.type === "INCOME" && e.category !== PDV_PROFIT_CATEGORY);
  const receivedTotal = receivedReceivables.reduce((sum, r) => sum + (r.receivedAmount ?? r.amount), 0);
  const income = incomeEntries.reduce((sum, e) => sum + e.amount, 0) + receivedTotal;
  // Lançamentos manuais de despesa continuam contabilizados, exceto a categoria
  // "PEÇA" — esse valor agora vem fresco de problemPartUsage acima, evitando contar
  // a mesma peça duas vezes para as poucas notas antigas que já tinham esse lançamento.
  const manualExpenses = entries
    .filter((e) => e.type === "EXPENSE" && e.category !== PART_COST_CATEGORY)
    .reduce((sum, e) => sum + e.amount, 0);
  const partsCost = partUsages.reduce((sum, u) => sum + u.unitCostSnapshot * u.quantity, 0);
  const paidPayablesTotal = paidPayables.reduce((sum, p) => sum + (p.paidAmount ?? p.amount), 0);
  const expenses = manualExpenses + partsCost + paidPayablesTotal;

  // Série mensal pra alimentar os gráficos do resumo — últimos 6 meses quando não há
  // filtro de período; dentro do período filtrado, quando houver um.
  const now = new Date();
  const rangeStart = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const rangeEnd = to ? new Date(to) : now;
  const monthly = new Map<string, { month: string; income: number; partsCost: number; paidPayables: number; manualExpenses: number }>();
  const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (cursor <= rangeEnd) {
    const key = monthKey(cursor);
    monthly.set(key, { month: key, income: 0, partsCost: 0, paidPayables: 0, manualExpenses: 0 });
    cursor.setMonth(cursor.getMonth() + 1);
  }
  for (const e of entries) {
    const bucket = monthly.get(monthKey(new Date(e.occurredAt)));
    if (!bucket) continue;
    if (e.type === "INCOME" && e.category !== PDV_PROFIT_CATEGORY) bucket.income += e.amount;
    else if (e.type === "EXPENSE" && e.category !== PART_COST_CATEGORY) bucket.manualExpenses += e.amount;
  }
  for (const r of receivedReceivables) {
    const bucket = monthly.get(monthKey(new Date(r.receivedAt ?? r.updatedAt)));
    if (bucket) bucket.income += r.receivedAmount ?? r.amount;
  }
  for (const u of partUsages) {
    const bucket = monthly.get(monthKey(new Date(u.createdAt)));
    if (bucket) bucket.partsCost += u.unitCostSnapshot * u.quantity;
  }
  for (const p of paidPayables) {
    const bucket = monthly.get(monthKey(new Date(p.paidAt ?? p.updatedAt)));
    if (bucket) bucket.paidPayables += p.paidAmount ?? p.amount;
  }
  const monthlySeries = Array.from(monthly.values()).map((m) => ({
    ...m,
    expenses: m.partsCost + m.paidPayables + m.manualExpenses,
  }));

  res.json({
    summary: {
      income,
      expenses,
      partsCost,
      paidPayables: paidPayablesTotal,
      manualExpenses,
      receivedReceivables: receivedTotal,
      profit: income - expenses,
      count: entries.length,
    },
    entries,
    monthly: monthlySeries,
  });
});

financeRouter.get("/expense-categories", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const rows = await prisma.financialEntry.findMany({
    where: { type: "EXPENSE" },
    distinct: ["category"],
    select: { category: true },
    orderBy: { category: "asc" },
  });
  res.json({ categories: rows.map((r) => r.category) });
});

const expenseSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  amount: z.number().min(0),
  occurredAt: z.string().datetime().optional(),
});

// Qualquer funcionário (não só admin) pode lançar um gasto próprio — aba Gastos.
// createdById vem sempre de req.user, nunca do corpo da requisição.
financeRouter.post("/expenses", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const entry = await prisma.financialEntry.create({
    data: {
      type: "EXPENSE",
      category: parsed.data.category,
      description: parsed.data.description,
      amount: parsed.data.amount,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
      createdById: req.user!.id,
    },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  res.status(201).json({ entry });
});

// Gastos que o próprio usuário lançou num período — usado pelo relatório em PDF na
// aba Gastos. Cada funcionário só vê os seus; o Resumo (admin) já tem o filtro geral.
financeRouter.get("/my-expenses", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const to = typeof req.query.to === "string" ? req.query.to : undefined;
  // "to" é só a data (sem hora) — soma um dia pra incluir o dia inteiro, não só a
  // meia-noite dele.
  const toExclusive = to ? new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000) : undefined;

  const entries = await prisma.financialEntry.findMany({
    where: {
      createdById: req.user!.id,
      type: "EXPENSE",
      ...(from || toExclusive ? { occurredAt: { ...(from ? { gte: new Date(from) } : {}), ...(toExclusive ? { lt: toExclusive } : {}) } } : {}),
    },
    orderBy: { occurredAt: "desc" },
  });

  res.json({ entries, total: entries.reduce((sum, e) => sum + e.amount, 0) });
});

const updateEntrySchema = z.object({
  type: z.enum(["INCOME", "EXPENSE"]).optional(),
  category: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  amount: z.number().min(0).optional(),
  occurredAt: z.string().datetime().optional(),
});

// Edição livre de um lançamento manual — usada pela aba de Fluxo de caixa (tudo
// editável) e pelo Resumo, ambas alimentadas pela mesma tabela.
financeRouter.patch("/entries/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateEntrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const existing = await prisma.financialEntry.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Lançamento não encontrado." });

  const entry = await prisma.financialEntry.update({
    where: { id: req.params.id },
    data: {
      type: parsed.data.type,
      category: parsed.data.category,
      description: parsed.data.description,
      amount: parsed.data.amount,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    },
  });

  res.json({ entry });
});
