import { Router } from "express";
import { requireAuth, requireRole } from "@/middleware/auth";
import { listAuditLogs } from "@/services/audit.service";

export const auditRouter = Router();

auditRouter.get("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const logs = await listAuditLogs(req.query as Record<string, unknown>);
  res.json({ logs });
});
