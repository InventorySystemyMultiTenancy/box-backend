import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { SERVICE_ORDER_STATUSES, STATUS_PROGRESS } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";

export const serviceOrdersRouter = Router();

const orderInclude = {
  vehicle: { include: { owner: { select: { id: true, name: true, email: true } } } },
  timelineEvents: {
    orderBy: { occurredAt: "asc" as const },
    include: { media: true, author: { select: { name: true } } },
  },
  parts: { include: { media: true, responsible: { select: { name: true } } } },
  approvals: {
    orderBy: { createdAt: "desc" as const },
    include: { media: true, partUsages: { include: { inventoryPart: true } } },
  },
  media: { orderBy: { createdAt: "desc" as const } },
};

function hidePricesForMechanic<T extends { approvals?: any[]; estimatedMin?: number | null; estimatedMax?: number | null }>(order: T, role: string): T {
  if (role !== "MECHANIC") return order;
  return {
    ...order,
    estimatedMin: null,
    estimatedMax: null,
    approvals: order.approvals?.map((approval) => ({
      ...approval,
      laborValue: null,
      partsValue: null,
      estimatedValue: null,
      partUsages: approval.partUsages?.map((usage: any) => ({
        ...usage,
        unitCostSnapshot: null,
        inventoryPart: usage.inventoryPart ? { ...usage.inventoryPart, unitCost: null } : usage.inventoryPart,
      })),
    })),
  };
}

serviceOrdersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const orders = await prisma.serviceOrder.findMany({
    where: isStaff ? {} : { vehicle: { ownerId: req.user!.id } },
    include: orderInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json({ orders: orders.map((order) => hidePricesForMechanic(order, req.user!.role)) });
});

const createOrderSchema = z.object({
  vehicleId: z.string(),
  estimatedMin: z.number().optional(),
  estimatedMax: z.number().optional(),
  scheduledAt: z.string().datetime().optional(),
});

serviceOrdersRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const code = await nextOrderCode();
  const order = await prisma.serviceOrder.create({
    data: {
      code,
      vehicleId: parsed.data.vehicleId,
      estimatedMin: parsed.data.estimatedMin,
      estimatedMax: parsed.data.estimatedMax,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
      status: "RECEIVED",
      progress: STATUS_PROGRESS.RECEIVED,
      timelineEvents: {
        create: { title: "Veículo entrou na oficina", done: true },
      },
    },
    include: orderInclude,
  });
  res.status(201).json({ order });
});

serviceOrdersRouter.get("/:id", requireAuth, async (req: AuthedRequest<{ id: string }>, res) => {
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, req.params.id);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id }, include: orderInclude });
  if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });
  res.json({ order: hidePricesForMechanic(order, req.user!.role) });
});

const statusSchema = z.object({
  status: z.enum(SERVICE_ORDER_STATUSES),
  progress: z.number().min(0).max(100).optional(),
});

serviceOrdersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Status inválido.", details: parsed.error.flatten() });

    const { status, progress } = parsed.data;
    if (status === "READY_FOR_PICKUP" && req.user!.role !== "ADMIN") {
      return res.status(403).json({ error: "Apenas o admin pode finalizar projetos." });
    }

    if (status === "READY_FOR_PICKUP") {
      const unresolvedParts = await prisma.vehiclePart.count({
        where: { serviceOrderId: req.params.id, status: { in: ["CRITICAL", "IN_PROGRESS", "WARNING"] } },
      });
      const pendingApprovals = await prisma.approval.count({
        where: { serviceOrderId: req.params.id, status: "PENDING" },
      });
      if (unresolvedParts > 0 || pendingApprovals > 0) {
        return res.status(409).json({ error: "Ainda há problemas não resolvidos nesta ordem de serviço." });
      }
    }

    const order = await prisma.$transaction(async (tx) => {
      const order = await tx.serviceOrder.update({
        where: { id: req.params.id },
        data: {
          status,
          progress: progress ?? STATUS_PROGRESS[status],
          completedAt: status === "READY_FOR_PICKUP" ? new Date() : undefined,
        },
      });

      if (status === "READY_FOR_PICKUP") {
        const existingIncome = await tx.financialEntry.findFirst({
          where: { serviceOrderId: order.id, type: "INCOME", category: "PROJETO" },
        });
        if (!existingIncome) {
          const approvals = await tx.approval.findMany({
            where: { serviceOrderId: order.id, status: "APPROVED" },
          });
          const total = approvals.reduce((sum, approval) => sum + (approval.estimatedValue ?? 0), 0) || order.estimatedMin || 0;
          await tx.financialEntry.create({
            data: {
              type: "INCOME",
              category: "PROJETO",
              description: `Entrada do projeto ${order.code}`,
              amount: total,
              serviceOrderId: order.id,
            },
          });
        }
      }

      return order;
    });

    emitToOrder(order.id, "status:update", { orderId: order.id, status: order.status, progress: order.progress });
    res.json({ order });
  }
);
