import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";

export const approvalsRouter = Router({ mergeParams: true });

approvalsRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const approvals = await prisma.approval.findMany({
    where: { serviceOrderId: orderId },
    include: { media: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ approvals });
});

const createApprovalSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  estimatedValue: z.number().optional(),
});

approvalsRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const parsed = createApprovalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const approval = await prisma.approval.create({
    data: { serviceOrderId: orderId, ...parsed.data, status: "PENDING" },
    include: { media: true },
  });

  await prisma.serviceOrder.update({ where: { id: orderId }, data: { status: "AWAITING_APPROVAL" } });

  emitToOrder(orderId, "approval:new", { approval });
  emitToOrder(orderId, "status:update", { orderId, status: "AWAITING_APPROVAL" });
  res.status(201).json({ approval });
});

// A resposta é sempre do cliente dono do veículo — mecânico/admin nunca aprovam em nome dele.
approvalsRouter.patch("/:approvalId", requireAuth, async (req: AuthedRequest<{ orderId: string; approvalId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });
  if (req.user!.role !== "CUSTOMER") {
    return res.status(403).json({ error: "Apenas o cliente pode aprovar ou reprovar." });
  }

  const bodySchema = z.object({ status: z.enum(["APPROVED", "REJECTED"]) });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Status inválido." });

  const approval = await prisma.approval.update({
    where: { id: req.params.approvalId },
    data: { status: parsed.data.status, respondedAt: new Date() },
  });

  await prisma.timelineEvent.create({
    data: {
      serviceOrderId: orderId,
      title: parsed.data.status === "APPROVED" ? "Cliente aprovou orçamento adicional" : "Cliente reprovou orçamento adicional",
      done: true,
    },
  });

  emitToOrder(orderId, "approval:update", { approval });
  res.json({ approval });
});
