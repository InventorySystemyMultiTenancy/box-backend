import { Router } from "express";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { listNotifications, notifyServiceOrderStatus } from "@/services/notifications.service";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, requireRole("ADMIN", "MECHANIC"), async (req, res) => {
  const notifications = await listNotifications(req.query as Record<string, unknown>);
  res.json({ notifications });
});

// Reenvio manual (além do disparo automático em mudanças de status).
export const orderNotifyRouter = Router({ mergeParams: true });

orderNotifyRouter.post("/notify", requireAuth, requireRole("ADMIN", "MECHANIC"), async (req: AuthedRequest<{ id: string }>, res) => {
  await notifyServiceOrderStatus(req.params.id);
  res.status(202).json({ ok: true });
});
