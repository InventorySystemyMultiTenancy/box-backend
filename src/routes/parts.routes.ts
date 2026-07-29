import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { PART_KEYS, PART_STATUSES } from "@/lib/constants";

export const partsRouter = Router({ mergeParams: true });

partsRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const parts = await prisma.vehiclePart.findMany({
    where: { serviceOrderId: orderId },
    include: { media: true, responsible: { select: { name: true } } },
  });
  res.json({ parts });
});

const upsertPartSchema = z.object({
  key: z.enum(PART_KEYS),
  name: z.string().min(1),
  status: z.enum(PART_STATUSES),
  note: z.string().optional(),
  wearLevel: z.number().min(0).max(100).optional(),
  warranty: z.string().optional(),
});

// Upsert: o mecânico atualiza o mesmo componente várias vezes ao longo do serviço
// (ex.: freios passa de WARNING -> IN_PROGRESS -> DONE) — é sempre uma única linha por peça/ordem.
partsRouter.put("/:key", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ orderId: string; key: string }>, res) => {
  const orderId = req.params.orderId;
  const parsed = upsertPartSchema.safeParse({ ...req.body, key: req.params.key });
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const { key, ...data } = parsed.data;
  const part = await prisma.vehiclePart.upsert({
    where: { serviceOrderId_key: { serviceOrderId: orderId, key } },
    create: { serviceOrderId: orderId, key, responsibleId: req.user!.id, ...data },
    update: { responsibleId: req.user!.id, ...data },
    include: { media: true, responsible: { select: { name: true } } },
  });

  emitToOrder(orderId, "part:update", { part });
  res.json({ part });
});
