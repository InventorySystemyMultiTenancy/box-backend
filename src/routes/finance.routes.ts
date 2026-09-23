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

financeRouter.get("/summary", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const [entries, partUsages, paidPayables] = await Promise.all([
    prisma.financialEntry.findMany({ orderBy: { occurredAt: "desc" } }),
    // Custo real de peças gastas em projetos — direto do uso registrado (não depende
    // mais do fluxo (hoje raro) de aprovação do cliente que gerava um FinancialEntry
    // "PEÇA" à parte; problemas reprovados não contam, o resto sim.
    prisma.problemPartUsage.findMany({
      where: { approval: { status: { not: "REJECTED" } } },
      select: { quantity: true, unitCostSnapshot: true, createdAt: true },
    }),
    // Toda conta a pagar já paga é saída de caixa: compra de peça para estoque, boleto
    // de nota fiscal, comissão paga, despesa fixa lançada em contas a pagar, etc.
    prisma.accountPayable.findMany({
      where: { status: "PAID" },
      select: { amount: true, paidAmount: true, paidAt: true, updatedAt: true },
    }),
  ]);

  const income = entries.filter((e) => e.type === "INCOME").reduce((sum, e) => sum + e.amount, 0);
  // Lançamentos manuais de despesa continuam contabilizados, exceto a categoria
  // "PEÇA" — esse valor agora vem fresco de problemPartUsage acima, evitando contar
  // a mesma peça duas vezes para as poucas notas antigas que já tinham esse lançamento.
  const manualExpenses = entries
    .filter((e) => e.type === "EXPENSE" && e.category !== "PEÇA")
    .reduce((sum, e) => sum + e.amount, 0);
  const partsCost = partUsages.reduce((sum, u) => sum + u.unitCostSnapshot * u.quantity, 0);
  const paidPayablesTotal = paidPayables.reduce((sum, p) => sum + (p.paidAmount ?? p.amount), 0);
  const expenses = manualExpenses + partsCost + paidPayablesTotal;

  // Série dos últimos 6 meses, pra alimentar os gráficos do resumo.
  const now = new Date();
  const monthly = new Map<string, { month: string; income: number; partsCost: number; paidPayables: number; manualExpenses: number }>();
  for (let i = 5; i >= 0; i--) {
    const key = monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1));
    monthly.set(key, { month: key, income: 0, partsCost: 0, paidPayables: 0, manualExpenses: 0 });
  }
  for (const e of entries) {
    const bucket = monthly.get(monthKey(new Date(e.occurredAt)));
    if (!bucket) continue;
    if (e.type === "INCOME") bucket.income += e.amount;
    else if (e.category !== "PEÇA") bucket.manualExpenses += e.amount;
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
      profit: income - expenses,
      count: entries.length,
    },
    entries,
    monthly: monthlySeries,
  });
});

const expenseSchema = z.object({
  category: z.string().min(1),
  description: z.string().min(1),
  amount: z.number().min(0),
  occurredAt: z.string().datetime().optional(),
});

financeRouter.post("/expenses", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const entry = await prisma.financialEntry.create({
    data: {
      type: "EXPENSE",
      category: parsed.data.category,
      description: parsed.data.description,
      amount: parsed.data.amount,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    },
  });

  res.status(201).json({ entry });
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
