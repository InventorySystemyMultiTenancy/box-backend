import fs from "fs";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { upload } from "@/middleware/upload";
import {
  listInvoices,
  createInvoiceDraft,
  issueInvoice,
  cancelInvoice,
  InvoiceError,
} from "@/services/invoices.service";
import { extractInvoiceFromImage, InvoiceOcrError } from "@/services/fiscal/invoice-ocr.service";
import { findOrCreateClientFromDocument } from "@/services/clients.service";

export const invoicesRouter = Router();

invoicesRouter.post(
  "/extract",
  requireAuth,
  requirePermission("invoices", "manage"),
  upload.single("photo"),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Envie uma imagem da nota fiscal." });

    try {
      const extracted = await extractInvoiceFromImage(req.file.path, req.file.mimetype);
      // Casa (ou cadastra automaticamente) o cliente identificado na imagem como
      // destinatário — o usuário só confirma no formulário antes de salvar a nota.
      const { client, created } = await findOrCreateClientFromDocument(extracted.recipientName, extracted.recipientDocument);
      res.json({ extracted, clientId: client?.id ?? null, clientName: client?.name ?? null, clientCreated: created });
    } catch (err) {
      if (err instanceof InvoiceOcrError) return res.status(err.status).json({ error: err.message });
      throw err;
    } finally {
      fs.promises.unlink(req.file.path).catch(() => {});
    }
  }
);

const createSchema = z.object({
  type: z.enum(["NFE", "NFSE", "NFCE"]),
  totalAmount: z.number().positive(),
  description: z.string().min(1),
  serviceOrderId: z.string().optional(),
  clientId: z.string().optional(),
  accountReceivableId: z.string().optional(),
  number: z.string().optional(),
  series: z.string().optional(),
  accessKey: z.string().optional(),
  operationNature: z.string().optional(),
  issuerName: z.string().optional(),
  issuerDocument: z.string().optional(),
  recipientName: z.string().optional(),
  recipientDocument: z.string().optional(),
  paymentMethod: z.string().optional(),
  discountAmount: z.number().min(0).optional(),
  taxAmount: z.number().min(0).optional(),
  issueDate: z.string().optional(),
  // Só usados quando paymentMethod é "boleto" — geram as contas a pagar (uma por
  // mês) a partir de dueDate, ligadas a esta nota.
  installments: z.coerce.number().int().min(1).max(60).optional(),
  dueDate: z.string().optional(),
});

invoicesRouter.get("/", requireAuth, requirePermission("invoices", "view"), async (req, res) => {
  const result = await listInvoices(req.query as Record<string, unknown>);
  res.json(result);
});

invoicesRouter.post("/", requireAuth, requirePermission("invoices", "manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const invoice = await createInvoiceDraft(parsed.data);
    res.status(201).json({ invoice });
  } catch (err) {
    if (err instanceof InvoiceError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
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
