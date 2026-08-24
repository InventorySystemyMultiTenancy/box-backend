import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";

export const vehicleDamagesRouter = Router({ mergeParams: true });

vehicleDamagesRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const damages = await prisma.vehicleDamage.findMany({
    where: { serviceOrderId: orderId },
    include: { media: true, author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  res.json({ damages });
});

const createSchema = z.object({
  description: z.string().min(1),
  location: z.string().optional(),
});

vehicleDamagesRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ orderId: string }>, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const damage = await prisma.vehicleDamage.create({
    data: { serviceOrderId: req.params.orderId, ...parsed.data, authorId: req.user!.id },
    include: { media: true, author: { select: { id: true, name: true } } },
  });
  res.status(201).json({ damage });
});
