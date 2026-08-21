import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listInvoices,
  createInvoiceDraft,
  issueInvoice,
  cancelInvoice,
  InvoiceError,
} from "@/services/invoices.service";

export const invoicesRouter = Router();

const createSchema = z.object({
  type: z.enum(["NFE", "NFSE", "NFCE"]),
  totalAmount: z.number().positive(),
  description: z.string().min(1),
  serviceOrderId: z.string().optional(),
  clientId: z.string().optional(),
  accountReceivableId: z.string().optional(),
});

invoicesRouter.get("/", requireAuth, requirePermission("invoices", "view"), async (req, res) => {
  const result = await listInvoices(req.query as Record<string, unknown>);
  res.json(result);
});

invoicesRouter.post("/", requireAuth, requirePermission("invoices", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const invoice = await createInvoiceDraft(parsed.data);
  res.status(201).json({ invoice });
});

invoicesRouter.post("/:id/issue", requireAuth, requirePermission("invoices", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const invoice = await issueInvoice(req.params.id);
    res.json({ invoice });
  } catch (err) {
    if (err instanceof InvoiceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

invoicesRouter.post("/:id/cancel", requireAuth, requirePermission("invoices", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const invoice = await cancelInvoice(req.params.id);
    res.json({ invoice });
  } catch (err) {
    if (err instanceof InvoiceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
