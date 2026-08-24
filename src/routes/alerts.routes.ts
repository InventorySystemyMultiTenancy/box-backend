import { Router } from "express";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { refreshAlerts, markAlertRead } from "@/services/alerts.service";

export const alertsRouter = Router();

alertsRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const notifications = await refreshAlerts();
  res.json({ notifications });
});

alertsRouter.patch("/:id/read", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const notification = await markAlertRead(req.params.id);
  res.json({ notification });
});
