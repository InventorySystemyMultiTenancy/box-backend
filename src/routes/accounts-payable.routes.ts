import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  createAccountsPayable,
  listAccountsPayable,
  payAccountPayable,
  updateAccountPayable,
  cancelAccountPayable,
  summarizeAccountsPayable,
  PayableError,
} from "@/services/accounts-payable.service";
import { listExpenseClassifications } from "@/services/expense-classifications.service";

export const accountsPayableRouter = Router();

const duplicateSchema = z.object({
  dueDate: z.string().min(1),
  amount: z.number().positive(),
  paymentMethod: z.string().optional(),
  documentNumber: z.string().optional(),
  paidAt: z.string().optional(),
  bankAccountId: z.string().optional(),
});

// Formulário "Cadastrar contas a pagar": cabeçalho (nota, fornecedor, grupo/descrição/setor,
// categoria) + duplicatas digitadas. Ainda aceita o formato antigo (amount + dueDate +
// installments), usado por integrações internas.
const createSchema = z
  .object({
    description: z.string().optional(),
    category: z.string().min(1, "Informe a categoria."),
    payeeName: z.string().min(1, "Informe o fornecedor."),
    supplierId: z.string().optional(),
    notes: z.string().optional(),
    paymentMethod: z.string().optional(),
    bankAccountId: z.string().optional(),
    expenseGroup: z.string().optional(),
    expenseDescription: z.string().optional(),
    expenseSector: z.string().optional(),
    invoiceNumber: z.string().optional(),
    issueDate: z.string().optional(),
    storeId: z.string().optional(),
    amount: z.number().positive().optional(),
    dueDate: z.string().optional(),
    installments: z.number().int().min(1).max(60).optional(),
    duplicates: z.array(duplicateSchema).max(120).optional(),
  })
  .refine((d) => (d.duplicates && d.duplicates.length > 0) || (d.amount !== undefined && d.dueDate), {
    message: "Informe ao menos uma duplicata (vencimento e valor).",
  });

const paySchema = z.object({
  paidAt: z.string().optional(),
  paidAmount: z.number().positive().optional(),
  bankAccountId: z.string().optional(),
  paymentMethod: z.string().optional(),
});

const updateSchema = z.object({
  description: z.string().min(1).optional(),
  category: z.string().min(1).optional(),
  payeeName: z.string().min(1).optional(),
  amount: z.number().positive().optional(),
  dueDate: z.string().optional(),
  paymentMethod: z.string().optional(),
  bankAccountId: z.string().optional(),
  notes: z.string().optional(),
  paidAt: z.string().optional(),
  paidAmount: z.number().positive().optional(),
  expenseGroup: z.string().optional(),
  expenseDescription: z.string().optional(),
  expenseSector: z.string().optional(),
  invoiceNumber: z.string().optional(),
  documentNumber: z.string().optional(),
});

// Classificações já usadas (categoria, grupo, descrição por grupo, setor) — sugestões dos
// formulários de conta a pagar e de nota fiscal de despesa.
accountsPayableRouter.get("/classifications", requireAuth, async (_req, res) => {
  res.json(await listExpenseClassifications());
});

// Totais do topo (em aberto / vencido / já pago), com os mesmos filtros da lista.
accountsPayableRouter.get("/summary", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  res.json({ summary: await summarizeAccountsPayable(req.query as Record<string, unknown>) });
});

accountsPayableRouter.get("/", requireAuth, requirePermission("finance", "view"), async (req, res) => {
  const result = await listAccountsPayable(req.query as Record<string, unknown>);
  res.json(result);
});

accountsPayableRouter.post("/", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message;
    return res.status(400).json({ error: message && !message.startsWith("Invalid") ? message : "Dados inválidos.", details: parsed.error.flatten() });
  }

  try {
    // Responsável pelo lançamento vem sempre do usuário logado, nunca do corpo.
    const installments = await createAccountsPayable({ ...parsed.data, createdById: req.user!.id });
    res.status(201).json({ installments });
  } catch (err) {
    if (err instanceof PayableError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
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

accountsPayableRouter.patch("/:id", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const payable = await updateAccountPayable(req.params.id, parsed.data);
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
