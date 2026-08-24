import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { getDashboardReport, getServiceOrderProfitability } from "@/services/reports.service";
import { AuthedRequest } from "@/middleware/auth";

export const reportsRouter = Router();

reportsRouter.get("/dashboard", requireAuth, requirePermission("reports", "view"), async (req, res) => {
  const report = await getDashboardReport(req.query as { from?: string; to?: string });
  res.json({ report });
});

reportsRouter.get(
  "/service-orders/:id/profitability",
  requireAuth,
  requirePermission("reports", "view"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const profitability = await getServiceOrderProfitability(req.params.id);
    res.json({ profitability });
  }
);
