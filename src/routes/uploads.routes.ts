import { Router } from "express";
import { prisma } from "@/lib/prisma";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { upload, guessMediaType, persistUploadedFile } from "@/middleware/upload";
import { emitToOrder } from "@/sockets";

export const uploadsRouter = Router();

// multipart/form-data: campo "file" + campos de texto serviceOrderId, label, partId?, timelineEventId?, approvalId?
uploadsRouter.post("/", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  if (!req.file) return res.status(400).json({ error: "Nenhum arquivo enviado." });

  const { serviceOrderId, label, partId, timelineEventId, approvalId } = req.body as Record<string, string | undefined>;
  if (!serviceOrderId) return res.status(400).json({ error: "serviceOrderId é obrigatório." });

  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, serviceOrderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const url = await persistUploadedFile(req.file);

  const media = await prisma.media.create({
    data: {
      serviceOrderId,
      partId: partId || undefined,
      timelineEventId: timelineEventId || undefined,
      approvalId: approvalId || undefined,
      url,
      type: guessMediaType(req.file.mimetype),
      label,
    },
  });

  emitToOrder(serviceOrderId, "media:new", { media });
  res.status(201).json({ media });
});
