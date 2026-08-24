import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import {
  listDocumentTemplates,
  updateDocumentTemplate,
  renderDocument,
  DocumentTemplateError,
} from "@/services/document-templates.service";

export const documentTemplatesRouter = Router();

documentTemplatesRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const templates = await listDocumentTemplates();
  res.json({ templates });
});

documentTemplatesRouter.patch("/:key", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ key: string }>, res) => {
  const parsed = z.object({ name: z.string().optional(), bodyHtml: z.string().optional(), active: z.coerce.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const template = await updateDocumentTemplate(req.params.key, parsed.data);
    res.json({ template });
  } catch (err) {
    if (err instanceof DocumentTemplateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Gera o HTML de um documento a partir de uma OS já existente (recibo, autorização,
// termo de entrega...), preenchendo os placeholders com dados de Client/Vehicle/OS.
documentTemplatesRouter.get(
  "/:key/render/:serviceOrderId",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ key: string; serviceOrderId: string }>, res) => {
    const order = await prisma.serviceOrder.findUnique({
      where: { id: req.params.serviceOrderId },
      include: { vehicle: { include: { owner: true } } },
    });
    if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

    try {
      const document = await renderDocument(req.params.key, {
        orderCode: order.code,
        vehicle: `${order.vehicle.brand} ${order.vehicle.model} ${order.vehicle.year}`,
        plate: order.vehicle.plate ?? "não informada",
        client: order.vehicle.owner.name,
        date: new Date().toLocaleDateString("pt-BR"),
      });
      res.json({ document });
    } catch (err) {
      if (err instanceof DocumentTemplateError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);
