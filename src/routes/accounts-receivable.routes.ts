import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  createAccountsReceivable,
  listAccountsReceivable,
  receiveAccountReceivable,
  receiveManyAccountsReceivable,
  updateAccountReceivable,
  cancelAccountReceivable,
  setAccountReceivableDueDate,
  createReceivableFromServiceOrder,
  summarizeAccountsReceivable,
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
  // Nota fiscal do recebimento: associar uma existente ou criar uma nova ligada à conta.
  invoiceId: z.string().optional(),
  newInvoice: z
    .object({
      number: z.string().min(1),
      series: z.string().optional(),
      type: z.enum(["NFE", "NFSE", "NFCE"]).optional(),
      issueDate: z.string().optional(),
    })
    .optional(),
});

const fromOrderSchema = z.object({
  serviceOrderId: z.string(),
  dueDate: z.string(),
});

// Coluna "Prazo": data (YYYY-MM-DD) ou null para tirar o prazo (fica vencida).
const dueDateSchema = z.object({ dueDate: z.string().nullable() });

const updateSchema = z.object({
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  clientId: z.string().optional(),
  amount: z.number().positive().optional(),
  dueDate: z.string().optional(),
  paymentMethod: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().optional(),
  receivedAt: z.string().optional(),
  receivedAmount: z.number().positive().optional(),
});

// Totais do topo (em aberto / vencido / já recebido), com os mesmos filtros da lista.
accountsReceivableRouter.get("/summary", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  res.json({ summary: await summarizeAccountsReceivable(req.query as Record<string, unknown>) });
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

// "Marcar como recebidas" (contas selecionadas): uma data por conta (YYYY-MM-DD) ou nenhuma (= hoje).
const receiveManySchema = z.object({
  items: z.array(z.object({ id: z.string(), receivedAt: z.string().optional() })).min(1).max(500),
});

accountsReceivableRouter.post("/receive-many", requireAuth, requirePermission("finance", "manage"), async (req, res) => {
  const parsed = receiveManySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Selecione ao menos uma conta.", details: parsed.error.flatten() });
  try {
    res.json(await receiveManyAccountsReceivable(parsed.data.items));
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

accountsReceivableRouter.patch("/:id", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const receivable = await updateAccountReceivable(req.params.id, parsed.data);
    res.json({ receivable });
  } catch (err) {
    if (err instanceof ReceivableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

accountsReceivableRouter.patch("/:id/due-date", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = dueDateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const receivable = await setAccountReceivableDueDate(req.params.id, parsed.data.dueDate);
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
