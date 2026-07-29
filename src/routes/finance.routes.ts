import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole } from "@/middleware/auth";

export const financeRouter = Router();

financeRouter.get("/summary", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const entries = await prisma.financialEntry.findMany({ orderBy: { occurredAt: "desc" } });
  const income = entries.filter((e) => e.type === "INCOME").reduce((sum, e) => sum + e.amount, 0);
  const expenses = entries.filter((e) => e.type === "EXPENSE").reduce((sum, e) => sum + e.amount, 0);
  const partsCost = entries.filter((e) => e.type === "EXPENSE" && e.category === "PEÇA").reduce((sum, e) => sum + e.amount, 0);

  res.json({
    summary: {
      income,
      expenses,
      partsCost,
      profit: income - expenses,
      count: entries.length,
    },
    entries,
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
