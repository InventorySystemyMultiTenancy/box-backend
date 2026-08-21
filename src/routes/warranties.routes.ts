import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { setPartWarranty, listExpiringWarranties, WarrantyError } from "@/services/warranties.service";

// Setter fica junto do domínio da OS/peça (mesma URL shape de parts/approvals).
export const partWarrantyRouter = Router({ mergeParams: true });

const setSchema = z.object({
  months: z.number().int().positive(),
  startAt: z.string().optional(),
});

partWarrantyRouter.patch(
  "/:partId/warranty",
  requireAuth,
  requirePermission("warranties", "manage"),
  async (req: AuthedRequest<{ orderId: string; partId: string }>, res) => {
    const parsed = setSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    try {
      const part = await setPartWarranty(req.params.orderId, req.params.partId, parsed.data.months, parsed.data.startAt);
      res.json({ part });
    } catch (err) {
      if (err instanceof WarrantyError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);

// Relatório de garantias vencendo — recurso próprio, sem depender de uma OS específica.
export const warrantiesReportRouter = Router();

warrantiesReportRouter.get("/expiring", requireAuth, requirePermission("warranties", "view"), async (req, res) => {
  const withinDays = Number(req.query.withinDays) || 30;
  const parts = await listExpiringWarranties(withinDays);
  res.json({ parts });
});
