import { Router } from "express";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { refreshAlerts, markAlertRead, filterAlertsForAccess } from "@/services/alerts.service";
import { getReportAccess } from "@/lib/report-access";

export const alertsRouter = Router();

// Cada usuário só recebe os alertas que o cargo dele libera (tipos e setores de despesa).
alertsRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const [all, access] = await Promise.all([refreshAlerts(), getReportAccess(req.user!.id)]);
  const notifications = await filterAlertsForAccess(all, access);
  res.json({ notifications });
});

alertsRouter.patch("/:id/read", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const notification = await markAlertRead(req.params.id);
  res.json({ notification });
});
