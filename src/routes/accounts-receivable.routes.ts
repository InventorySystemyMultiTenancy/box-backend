import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  createAccountsReceivable,
  listAccountsReceivable,
  receiveAccountReceivable,
  cancelAccountReceivable,
  createReceivableFromServiceOrder,
  ReceivableError,
} from "@/services/accounts-receivable.service";

export const accountsReceivableRouter = Router();

const createSchema = z.object({
  description: z.string().min(1),
  category: z.string().min(1),
  clientId: z.string().optional(),
  serviceOrderId: z.string().optional(),
  amount: z.number().positive(),
  dueDate: z.string(),
  paymentMethod: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().optional(),
  installments: z.number().int().min(1).max(60).optional(),
});

const receiveSchema = z.object({
  receivedAt: z.string().optional(),
  receivedAmount: z.number().positive().optional(),
  bankAccountId: z.string().optional(),
  paymentMethod: z.string().optional(),
});

const fromOrderSchema = z.object({
  serviceOrderId: z.string(),
  dueDate: z.string(),
});

accountsReceivableRouter.get("/", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  const result = await listAccountsReceivable(req.query as Record<string, unknown>);
  res.json(result);
});

accountsReceivableRouter.post("/", requireAuth, requirePermission("finance", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const installments = await createAccountsReceivable(parsed.data);
  res.status(201).json({ installments });
});

accountsReceivableRouter.post("/from-service-order", requireAuth, requirePermission("finance", "manage"), async (req, res) => {
  const parsed = fromOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const receivable = await createReceivableFromServiceOrder(parsed.data.serviceOrderId, parsed.data.dueDate);
    res.status(201).json({ receivable });
  } catch (err) {
    if (err instanceof ReceivableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

accountsReceivableRouter.post("/:id/receive", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = receiveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const receivable = await receiveAccountReceivable(req.params.id, parsed.data);
    res.json({ receivable });
  } catch (err) {
    if (err instanceof ReceivableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

accountsReceivableRouter.post("/:id/cancel", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const receivable = await cancelAccountReceivable(req.params.id);
    res.json({ receivable });
  } catch (err) {
    if (err instanceof ReceivableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
