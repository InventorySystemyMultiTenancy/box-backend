import { Router } from "express";
import { requireAuth } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { getDashboardReport } from "@/services/reports.service";

export const reportsRouter = Router();

reportsRouter.get("/dashboard", requireAuth, requirePermission("reports", "view"), async (req, res) => {
  const report = await getDashboardReport(req.query as { from?: string; to?: string });
  res.json({ report });
});
