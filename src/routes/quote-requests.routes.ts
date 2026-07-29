import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { emitToStaff, emitToUser } from "@/sockets";
import { STATUS_PROGRESS } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";

export const quoteRequestsRouter = Router();

const quoteRequestInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  mechanic: { select: { id: true, name: true } },
  vehicle: true,
  serviceOrder: { select: { id: true, code: true, status: true } },
};

quoteRequestsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;

  const requests = await prisma.quoteRequest.findMany({
    where: {
      ...(isStaff ? {} : { customerId: req.user!.id }),
      ...(statusFilter ? { status: statusFilter } : {}),
    },
    include: quoteRequestInclude,
    orderBy: { createdAt: "desc" },
  });
  res.json({ requests });
});

const createSchema = z.object({
  vehicle: z.object({
    brand: z.string().min(1),
    model: z.string().min(1),
    year: z.number().int().min(1950).max(2100),
    engine: z.string().optional(),
    plate: z.string().optional(),
    mileage: z.number().int().min(0).default(0),
  }),
  problemDescription: z.string().min(4),
  preferredDates: z.string().min(1),
});

quoteRequestsRouter.post("/", requireAuth, requireRole("CUSTOMER"), async (req: AuthedRequest, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const pending = await prisma.quoteRequest.findFirst({
    where: { customerId: req.user!.id, status: "PENDING" },
  });
  if (pending) {
    return res.status(409).json({ error: "Você já tem uma solicitação de orçamento aguardando resposta." });
  }

  const activeOrder = await prisma.serviceOrder.findFirst({
    where: {
      vehicle: { ownerId: req.user!.id },
      status: { notIn: ["FINISHED", "READY_FOR_PICKUP"] },
    },
  });
  if (activeOrder) {
    return res.status(409).json({ error: "Você já tem uma manutenção em andamento." });
  }

  const { vehicle, problemDescription, preferredDates } = parsed.data;
  const request = await prisma.quoteRequest.create({
    data: {
      customer: { connect: { id: req.user!.id } },
      problemDescription,
      preferredDates,
      vehicle: { create: { ...vehicle, owner: { connect: { id: req.user!.id } } } },
    },
    include: quoteRequestInclude,
  });

  emitToStaff("quote-request:new", { request });
  res.status(201).json({ request });
});

const acceptSchema = z.object({
  scheduledAt: z.string().datetime(),
  initialValue: z.number().min(0).optional(),
});

quoteRequestsRouter.patch(
  "/:id/accept",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    const existing = await prisma.quoteRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Solicitação não encontrada." });
    if (existing.status !== "PENDING") return res.status(409).json({ error: "Esta solicitação já foi respondida." });

    const mechanic = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const { scheduledAt, initialValue } = parsed.data;
    const scheduledDate = new Date(scheduledAt);

    const { request, order } = await prisma.$transaction(async (tx) => {
      const code = await nextOrderCode();
      const order = await tx.serviceOrder.create({
        data: {
          code,
          vehicleId: existing.vehicleId,
          status: "SCHEDULED",
          progress: STATUS_PROGRESS.SCHEDULED,
          estimatedMin: initialValue,
          scheduledAt: scheduledDate,
          timelineEvents: {
            create: {
              title: `Orçamento aceito por ${mechanic?.name ?? "a oficina"}`,
              description: `Agendado para ${scheduledDate.toLocaleString("pt-BR")}`,
              authorId: req.user!.id,
            },
          },
        },
      });

      const request = await tx.quoteRequest.update({
        where: { id: existing.id },
        data: {
          status: "ACCEPTED",
          mechanicId: req.user!.id,
          scheduledAt: scheduledDate,
          initialValue,
          respondedAt: new Date(),
          serviceOrderId: order.id,
        },
        include: quoteRequestInclude,
      });

      return { request, order };
    });

    emitToUser(existing.customerId, "quote-request:update", { request });
    emitToStaff("quote-request:update", { request });
    emitToStaff("service-order:new", { order });
    res.json({ request });
  }
);

const declineSchema = z.object({
  declineReason: z.string().optional(),
});

quoteRequestsRouter.patch(
  "/:id/decline",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = declineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });

    const existing = await prisma.quoteRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: "Solicitação não encontrada." });
    if (existing.status !== "PENDING") return res.status(409).json({ error: "Esta solicitação já foi respondida." });

    const request = await prisma.quoteRequest.update({
      where: { id: existing.id },
      data: {
        status: "DECLINED",
        mechanicId: req.user!.id,
        declineReason: parsed.data.declineReason,
        respondedAt: new Date(),
      },
      include: quoteRequestInclude,
    });

    emitToUser(existing.customerId, "quote-request:update", { request });
    emitToStaff("quote-request:update", { request });
    res.json({ request });
  }
);
