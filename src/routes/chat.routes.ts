import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";

export const chatRouter = Router({ mergeParams: true });

chatRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const messages = await prisma.chatMessage.findMany({
    where: { serviceOrderId: orderId },
    orderBy: { createdAt: "asc" },
  });
  res.json({ messages });
});

const sendSchema = z.object({
  body: z.string().optional(),
  attachmentUrl: z.string().optional(),
  senderName: z.string(),
});

chatRouter.post("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Mensagem inválida." });
  if (!parsed.data.body && !parsed.data.attachmentUrl) {
    return res.status(400).json({ error: "Envie um texto ou um anexo." });
  }

  const message = await prisma.chatMessage.create({
    data: {
      serviceOrderId: orderId,
      senderRole: req.user!.role === "CUSTOMER" ? "CUSTOMER" : "MECHANIC",
      senderName: parsed.data.senderName,
      body: parsed.data.body,
      attachmentUrl: parsed.data.attachmentUrl,
    },
  });

  emitToOrder(orderId, "chat:message", { message });
  res.status(201).json({ message });
});
