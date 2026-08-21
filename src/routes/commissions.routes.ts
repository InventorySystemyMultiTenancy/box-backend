import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { generateCommissions, listCommissions, payCommission, cancelCommission, CommissionError } from "@/services/commissions.service";

export const commissionsRouter = Router();

const generateSchema = z.object({ from: z.string(), to: z.string() });
const paySchema = z.object({ bankAccountId: z.string().optional() });

commissionsRouter.get("/", requireAuth, requirePermission("commissions", "view"), async (req, res) => {
  const result = await listCommissions(req.query as Record<string, unknown>);
  res.json(result);
});

commissionsRouter.post("/generate", requireAuth, requirePermission("commissions", "manage"), async (req, res) => {
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const created = await generateCommissions(parsed.data.from, parsed.data.to);
  res.status(201).json({ created });
});

commissionsRouter.post("/:id/pay", requireAuth, requirePermission("commissions", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const commission = await payCommission(req.params.id, parsed.data.bankAccountId);
    res.json({ commission });
  } catch (err) {
    if (err instanceof CommissionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

commissionsRouter.post("/:id/cancel", requireAuth, requirePermission("commissions", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const commission = await cancelCommission(req.params.id);
    res.json({ commission });
  } catch (err) {
    if (err instanceof CommissionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
