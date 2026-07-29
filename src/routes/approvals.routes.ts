import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { STATUS_PROGRESS } from "@/lib/constants";

export const approvalsRouter = Router({ mergeParams: true });

approvalsRouter.get("/", requireAuth, async (req: AuthedRequest<{ orderId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const approvals = await prisma.approval.findMany({
    where: { serviceOrderId: orderId },
    include: { media: true, partUsages: { include: { inventoryPart: true } } },
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

approvalsRouter.patch("/:approvalId", requireAuth, async (req: AuthedRequest<{ orderId: string; approvalId: string }>, res) => {
  const orderId = req.params.orderId;
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });
  if (req.user!.role !== "CUSTOMER") {
    return res.status(403).json({ error: "Apenas o cliente pode aprovar ou reprovar." });
  }

  const bodySchema = z.object({
    status: z.enum(["APPROVED", "REJECTED"]),
    responseNote: z.string().trim().optional(),
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Status inválido." });
  if (parsed.data.status === "REJECTED" && !parsed.data.responseNote) {
    return res.status(400).json({ error: "Informe o motivo da reprovação." });
  }

  const isApproved = parsed.data.status === "APPROVED";
  const beforeApproval = await prisma.approval.findUnique({ where: { id: req.params.approvalId } });
  if (!beforeApproval || beforeApproval.serviceOrderId !== orderId) {
    return res.status(404).json({ error: "Aprovação não encontrada." });
  }
  if (isApproved && beforeApproval.estimatedValue == null) {
    return res.status(409).json({ error: "Este problema ainda precisa ser precificado pelo admin." });
  }

  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
    const approval = await tx.approval.update({
      where: { id: req.params.approvalId },
      data: {
        status: parsed.data.status,
        responseNote: parsed.data.status === "REJECTED" ? parsed.data.responseNote : null,
        respondedAt: new Date(),
      },
      include: { media: true, partUsages: { include: { inventoryPart: true } } },
    });

    if (isApproved && approval.stockAppliedAt == null && approval.partUsages.length > 0) {
      for (const usage of approval.partUsages) {
        if (usage.inventoryPart.stockQty < usage.quantity) {
          throw new Error("INSUFFICIENT_STOCK");
        }
        await tx.inventoryPart.update({
          where: { id: usage.inventoryPartId },
          data: { stockQty: { decrement: usage.quantity } },
        });
        await tx.financialEntry.create({
          data: {
            type: "EXPENSE",
            category: "PEÇA",
            description: `${usage.quantity}x ${usage.inventoryPart.name} usado em problema aprovado`,
            amount: usage.unitCostSnapshot * usage.quantity,
            serviceOrderId: orderId,
            approvalId: approval.id,
            inventoryPartId: usage.inventoryPartId,
            partUsageId: usage.id,
          },
        });
      }
      await tx.approval.update({
        where: { id: approval.id },
        data: { stockAppliedAt: new Date() },
      });
    }

    const event = await tx.timelineEvent.create({
      data: {
        serviceOrderId: orderId,
        title: isApproved ? "Cliente aprovou orçamento adicional" : "Cliente reprovou orçamento adicional",
        description: parsed.data.status === "REJECTED" ? parsed.data.responseNote : undefined,
        done: true,
        authorId: req.user!.id,
      },
      include: { media: true, author: { select: { name: true } } },
    });

    // Aprovado: a peça entra em reparo e a ordem volta para "reparação em andamento".
    let part = null;
    if (isApproved && approval.partId) {
      part = await tx.vehiclePart.update({
        where: { id: approval.partId },
        data: { status: "IN_PROGRESS" },
        include: { media: true, responsible: { select: { name: true } } },
      });
      await tx.serviceOrder.update({
        where: { id: orderId },
        data: { status: "IN_PROGRESS", progress: STATUS_PROGRESS.IN_PROGRESS },
      });
    }

      return { approval, event, part };
    });
  } catch (err) {
    if (err instanceof Error && err.message === "INSUFFICIENT_STOCK") {
      return res.status(409).json({ error: "Estoque insuficiente para aprovar este problema." });
    }
    throw err;
  }

  const { approval, event, part } = result;

  emitToOrder(orderId, "approval:update", { approval });
  emitToOrder(orderId, "timeline:new", { event });
  if (part) {
    emitToOrder(orderId, "part:update", { part });
    emitToOrder(orderId, "status:update", { orderId, status: "IN_PROGRESS", progress: STATUS_PROGRESS.IN_PROGRESS });
  }
  res.json({ approval });
});
