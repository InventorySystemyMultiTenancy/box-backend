import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";

export const timelineRouter = Router({ mergeParams: true });

timelineRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const events = await prisma.timelineEvent.findMany({
    where: { serviceOrderId: orderId },
    include: { media: true, author: { select: { name: true } } },
    orderBy: { occurredAt: "asc" },
  });
  res.json({ events });
});

const createEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
  done: z.boolean().optional(),
});

timelineRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const parsed = createEventSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const event = await prisma.timelineEvent.create({
    data: {
      serviceOrderId: orderId,
      title: parsed.data.title,
      description: parsed.data.description,
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : new Date(),
      done: parsed.data.done ?? true,
      authorId: req.user!.id,
    },
    include: { media: true },
  });

  emitToOrder(orderId, "timeline:new", { event });
  res.status(201).json({ event });
});
