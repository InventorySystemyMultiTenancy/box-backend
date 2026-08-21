import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listBankAccounts,
  getBankAccountDetail,
  createBankAccount,
  updateBankAccount,
  archiveBankAccount,
  BankAccountError,
} from "@/services/bank-accounts.service";

export const bankAccountsRouter = Router();

const bankAccountSchema = z.object({
  name: z.string().min(2),
  bank: z.string().optional(),
  agency: z.string().optional(),
  accountNumber: z.string().optional(),
  initialBalance: z.number().optional(),
});

bankAccountsRouter.get("/", requireAuth, requirePermission("finance", "view"), async (_req, res) => {
  const accounts = await listBankAccounts();
  res.json({ accounts });
});

bankAccountsRouter.get("/:id", requireAuth, requirePermission("finance", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const account = await getBankAccountDetail(req.params.id);
    res.json({ account });
  } catch (err) {
    if (err instanceof BankAccountError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

bankAccountsRouter.post("/", requireAuth, requirePermission("finance", "manage"), async (req, res) => {
  const parsed = bankAccountSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const account = await createBankAccount(parsed.data);
  res.status(201).json({ account });
});

bankAccountsRouter.patch("/:id", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = bankAccountSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const account = await updateBankAccount(req.params.id, parsed.data);
    res.json({ account });
  } catch (err) {
    if (err instanceof BankAccountError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

bankAccountsRouter.delete("/:id", requireAuth, requirePermission("finance", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveBankAccount(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof BankAccountError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
