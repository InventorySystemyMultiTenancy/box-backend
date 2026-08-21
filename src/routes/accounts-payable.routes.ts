import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  createAccountsPayable,
  listAccountsPayable,
  payAccountPayable,
  cancelAccountPayable,
  PayableError,
} from "@/services/accounts-payable.service";

export const accountsPayableRouter = Router();

const createSchema = z.object({
  description: z.string().min(1),
  category: z.string().min(1),
  payeeName: z.string().min(1),
  amount: z.number().positive(),
  dueDate: z.string(),
  paymentMethod: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().optional(),
  installments: z.number().int().min(1).max(60).optional(),
});

const paySchema = z.object({
  paidAt: z.string().optional(),
  paidAmount: z.number().positive().optional(),
  bankAccountId: z.string().optional(),
  paymentMethod: z.string().optional(),
});

accountsPayableRouter.get("/", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  const result = await listAccountsPayable(req.query as Record<string, unknown>);
  res.json(result);
});

accountsPayableRouter.post("/", requireAuth, requirePermission("finance", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const installments = await createAccountsPayable(parsed.data);
  res.status(201).json({ installments });
});

accountsPayableRouter.post("/:id/pay", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = paySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const payable = await payAccountPayable(req.params.id, parsed.data);
    res.json({ payable });
  } catch (err) {
    if (err instanceof PayableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

accountsPayableRouter.post("/:id/cancel", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const payable = await cancelAccountPayable(req.params.id);
    res.json({ payable });
  } catch (err) {
    if (err instanceof PayableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
