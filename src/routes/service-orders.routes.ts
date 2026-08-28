import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { SERVICE_ORDER_STATUSES, STATUS_PROGRESS, STATUS_LABELS } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";
import { upload, persistUploadedFile } from "@/middleware/upload";
import { recordAudit } from "@/services/audit.service";

export const serviceOrdersRouter = Router();

const orderInclude = {
  vehicle: { include: { owner: { select: { id: true, name: true, email: true, phone: true } } } },
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
  consultant: { select: { id: true, name: true } },
  estimator: { select: { id: true, name: true } },
  technician: { select: { id: true, name: true } },
  currentSector: true,
  insuranceCompany: true,
};

function hidePricesForMechanic<T extends { approvals?: any[]; estimatedMin?: number | null; estimatedMax?: number | null; deliveryExtraValue?: number | null }>(order: T, role: string): T {
  if (role !== "MECHANIC") return order;
  return {
    ...order,
    estimatedMin: null,
    estimatedMax: null,
    deliveryExtraValue: null,
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
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
  const currentSectorId = typeof req.query.sectorId === "string" ? req.query.sectorId : undefined;
  const priority = typeof req.query.priority === "string" ? req.query.priority : undefined;
  const insuranceCompanyId = typeof req.query.insuranceCompanyId === "string" ? req.query.insuranceCompanyId : undefined;
  const includeArchived = req.query.includeArchived === "true";
  const orders = await prisma.serviceOrder.findMany({
    where: {
      ...(isStaff ? {} : { vehicle: { ownerId: req.user!.id } }),
      // Projeto com baixa dada some da lista/kanban de projetos em andamento (staff),
      // mas segue acessível por GET /:id, histórico do cliente e busca — nunca é apagado.
      ...(isStaff && !includeArchived ? { archivedAt: null } : {}),
      ...(storeId ? { storeId } : {}),
      ...(currentSectorId ? { currentSectorId } : {}),
      ...(priority ? { priority } : {}),
      ...(insuranceCompanyId ? { insuranceCompanyId } : {}),
    },
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
  storeId: z.string().optional(),
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
      storeId: parsed.data.storeId,
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

const processSchema = z.object({
  consultantId: z.string().nullable().optional(),
  estimatorId: z.string().nullable().optional(),
  technicianId: z.string().nullable().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  deliveryForecastAt: z.string().datetime().nullable().optional(),
  deliveryForecastReason: z.string().nullable().optional(),
  currentSectorId: z.string().nullable().optional(),
  insuranceCompanyId: z.string().nullable().optional(),
  claimNumber: z.string().nullable().optional(),
  deductibleAmount: z.coerce.number().nullable().optional(),
  serviceType: z.string().nullable().optional(),
  authorizationNumber: z.string().nullable().optional(),
});

// Campos de processo (Fase 1 do gap SIGMA): consultor/orçamentista/técnico, prioridade,
// previsão de entrega, setor físico e dados de seguro/sinistro. Distinto de /status
// (ciclo operacional) e /finalize (entrega) — não sobrepõe as rotas já existentes.
serviceOrdersRouter.patch("/:id/process", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = processSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const before = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
  if (!before) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const { deliveryForecastAt, ...rest } = parsed.data;
  const events: { title: string; description?: string }[] = [];

  if (rest.currentSectorId !== undefined && rest.currentSectorId !== before.currentSectorId) {
    const [fromSector, toSector] = await Promise.all([
      before.currentSectorId ? prisma.sector.findUnique({ where: { id: before.currentSectorId } }) : null,
      rest.currentSectorId ? prisma.sector.findUnique({ where: { id: rest.currentSectorId } }) : null,
    ]);
    events.push({
      title: "Veículo mudou de setor",
      description: `${fromSector?.name ?? "Sem setor"} → ${toSector?.name ?? "Sem setor"}`,
    });
  }
  if (deliveryForecastAt !== undefined && String(deliveryForecastAt) !== String(before.deliveryForecastAt?.toISOString() ?? null)) {
    events.push({
      title: "Previsão de entrega alterada",
      description: [
        deliveryForecastAt ? `Nova previsão: ${new Date(deliveryForecastAt).toLocaleString("pt-BR")}` : "Previsão removida",
        rest.deliveryForecastReason ? `Motivo: ${rest.deliveryForecastReason}` : undefined,
      ]
        .filter(Boolean)
        .join(" — "),
    });
  }

  const order = await prisma.$transaction(async (tx) => {
    const updated = await tx.serviceOrder.update({
      where: { id: req.params.id },
      data: { ...rest, ...(deliveryForecastAt !== undefined ? { deliveryForecastAt: deliveryForecastAt ? new Date(deliveryForecastAt) : null } : {}) },
    });
    for (const event of events) {
      await tx.timelineEvent.create({
        data: { serviceOrderId: updated.id, title: event.title, description: event.description, authorId: req.user!.id },
      });
    }
    return updated;
  });

  if (events.length) emitToOrder(order.id, "timeline:new", {});
  res.json({ order });
});

const statusSchema = z.object({
  status: z.enum(SERVICE_ORDER_STATUSES),
  progress: z.coerce.number().min(0).max(100).optional(),
});

// Avançar etapa — usado tanto pelo drag-and-drop do Kanban (sem foto) quanto pelo
// botão "Avançar etapa" dentro do projeto (com foto opcional). Aceita JSON ou
// multipart/form-data (upload.single só processa o segundo caso, o primeiro passa
// direto pelo express.json já aplicado globalmente). Toda mudança gera um evento
// na timeline, com a foto anexada quando houver.
serviceOrdersRouter.patch(
  "/:id/status",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = statusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Status inválido.", details: parsed.error.flatten() });

    const { status, progress } = parsed.data;
    if (status === "READY_FOR_PICKUP") {
      return res.status(400).json({ error: "Use /api/service-orders/:id/finalize para finalizar e entregar o veículo." });
    }

    const before = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

    const photoUrl = req.file ? await persistUploadedFile(req.file) : undefined;
    const statusChanged = before.status !== status;

    const { order, event } = await prisma.$transaction(async (tx) => {
      const order = await tx.serviceOrder.update({
        where: { id: req.params.id },
        data: { status, progress: progress ?? STATUS_PROGRESS[status] },
      });

      let event = null;
      if (statusChanged || photoUrl) {
        event = await tx.timelineEvent.create({
          data: {
            serviceOrderId: order.id,
            title: statusChanged ? `Etapa avançada: ${STATUS_LABELS[status]}` : `Foto adicionada — ${STATUS_LABELS[status]}`,
            authorId: req.user!.id,
          },
          include: { media: true, author: { select: { name: true } } },
        });
        if (photoUrl) {
          await tx.media.create({
            data: { serviceOrderId: order.id, timelineEventId: event.id, url: photoUrl, type: "PHOTO", label: `Foto — ${STATUS_LABELS[status]}` },
          });
          event = await tx.timelineEvent.findUniqueOrThrow({
            where: { id: event.id },
            include: { media: true, author: { select: { name: true } } },
          });
        }
      }

      return { order, event };
    });

    await recordAudit({
      userId: req.user!.id,
      action: "STATUS_CHANGE",
      entity: "ServiceOrder",
      entityId: order.id,
      before: { status: before.status },
      after: { status: order.status },
    });

    emitToOrder(order.id, "status:update", { orderId: order.id, status: order.status, progress: order.progress });
    if (event) emitToOrder(order.id, "timeline:new", { event });
    res.json({ order, event });
  }
);

const finalizeSchema = z.object({
  description: z.string().optional(),
  extraValue: z.coerce.number().min(0).optional(),
});

// Admin finaliza e entrega o veículo: além de liberar a retirada, pode registrar uma
// foto extra do veículo pronto, uma descrição e um valor extra (ex.: lavagem, taxa de
// entrega) somado por fora dos preços já aprovados dos problemas/peças.
serviceOrdersRouter.patch(
  "/:id/finalize",
  requireAuth,
  requireRole("ADMIN"),
  upload.single("photo"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = finalizeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    // Só exige que o próprio trabalho da oficina esteja concluído (peças sem status
    // CRITICAL/IN_PROGRESS/WARNING) — não trava a entrega esperando resposta do
    // cliente a uma aprovação. Mecânico/admin podem forçar uma peça para concluída
    // (POST .../:partId/resolve) mesmo sem aprovação, e a entrega segue esse mesmo critério.
    const unresolvedParts = await prisma.vehiclePart.count({
      where: { serviceOrderId: req.params.id, status: { in: ["CRITICAL", "IN_PROGRESS", "WARNING"] } },
    });
    if (unresolvedParts > 0) {
      return res.status(409).json({ error: "Ainda há problemas não resolvidos nesta ordem de serviço." });
    }

    const photoUrl = req.file ? await persistUploadedFile(req.file) : undefined;
    const { description, extraValue } = parsed.data;

    const order = await prisma.$transaction(async (tx) => {
      const order = await tx.serviceOrder.update({
        where: { id: req.params.id },
        data: {
          status: "READY_FOR_PICKUP",
          progress: STATUS_PROGRESS.READY_FOR_PICKUP,
          completedAt: new Date(),
          deliveryDescription: description,
          deliveryExtraValue: extraValue,
        },
      });

      const existingIncome = await tx.financialEntry.findFirst({
        where: { serviceOrderId: order.id, type: "INCOME", category: "PROJETO" },
      });
      if (!existingIncome) {
        // Receita da oficina = trabalho de fato concluído (peça com status DONE), não
        // só o que o cliente aprovou formalmente — mão de obra e peças de um reparo
        // finalizado (inclusive sem resposta do cliente) entram como lucro da Reblind
        // igual a qualquer outro, já que o veículo só chega à entrega com o serviço feito.
        const approvals = await tx.approval.findMany({
          where: { serviceOrderId: order.id, part: { status: "DONE" } },
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

      if (extraValue && extraValue > 0) {
        await tx.financialEntry.create({
          data: {
            type: "INCOME",
            category: "ENTREGA_EXTRA",
            description: `Valor extra na entrega — ${order.code}`,
            amount: extraValue,
            serviceOrderId: order.id,
          },
        });
      }

      if (photoUrl) {
        await tx.media.create({
          data: {
            serviceOrderId: order.id,
            url: photoUrl,
            type: "PHOTO",
            label: "Foto de entrega do veículo",
            isDeliveryPhoto: true,
          },
        });
      }

      return tx.serviceOrder.findUnique({ where: { id: order.id }, include: orderInclude });
    });

    emitToOrder(order!.id, "status:update", { orderId: order!.id, status: order!.status, progress: order!.progress });
    res.json({ order });
  }
);

// "Dar baixa": admin encerra o projeto independente de qualquer aprovação/confirmação
// do cliente — a única exigência é que o veículo já esteja pronto para retirada. O
// projeto some da lista/kanban de projetos em andamento (ver GET /), mas continua
// salvo como concluído (acessível por código/histórico) e a garantia das peças, que
// não depende do status da ordem, segue funcionando normalmente.
serviceOrdersRouter.patch("/:id/archive", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const existing = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ error: "Ordem de serviço não encontrada." });
  if (existing.status !== "READY_FOR_PICKUP") {
    return res.status(409).json({ error: "Só é possível dar baixa em um projeto pronto para retirada." });
  }
  if (existing.archivedAt) return res.status(409).json({ error: "Este projeto já está com baixa dada." });

  const order = await prisma.serviceOrder.update({
    where: { id: req.params.id },
    data: { archivedAt: new Date() },
    include: orderInclude,
  });

  emitToOrder(order.id, "service-order:archived", { orderId: order.id, archivedAt: order.archivedAt });
  res.json({ order: hidePricesForMechanic(order, req.user!.role) });
});

// Exclusão definitiva do projeto (diferente de "dar baixa", que só encerra e mantém o
// histórico). Recusa se já existe qualquer rastro financeiro (comissão, nota fiscal,
// conta a receber ou lançamento) — nesses casos o projeto já afeta a contabilidade da
// oficina e não pode simplesmente sumir; use "Dar baixa" para encerrá-lo em vez disso.
// Sem rastro financeiro, apaga em cascata tudo que só existe em função deste projeto
// (timeline, peças, aprovações, mídia, chat, orçamentos formais, vistorias, avarias).
serviceOrdersRouter.delete("/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const { id } = req.params;
  const existing = await prisma.serviceOrder.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const [commissions, invoices, receivables, financialEntries] = await Promise.all([
    prisma.commission.count({ where: { serviceOrderId: id } }),
    prisma.invoice.count({ where: { serviceOrderId: id } }),
    prisma.accountReceivable.count({ where: { serviceOrderId: id } }),
    prisma.financialEntry.count({ where: { serviceOrderId: id } }),
  ]);
  if (commissions > 0 || invoices > 0 || receivables > 0 || financialEntries > 0) {
    return res.status(409).json({
      error: "Este projeto já tem comissão, nota fiscal, conta a receber ou lançamento financeiro vinculado — não pode ser excluído. Use \"Dar baixa\" para encerrá-lo.",
    });
  }

  await recordAudit({
    userId: req.user!.id,
    action: "DELETE",
    entity: "ServiceOrder",
    entityId: id,
    before: existing,
  });

  await prisma.$transaction([
    prisma.media.deleteMany({ where: { serviceOrderId: id } }),
    prisma.chatMessage.deleteMany({ where: { serviceOrderId: id } }),
    prisma.approval.deleteMany({ where: { serviceOrderId: id } }),
    prisma.vehiclePart.deleteMany({ where: { serviceOrderId: id } }),
    prisma.estimate.deleteMany({ where: { serviceOrderId: id } }),
    prisma.inspection.deleteMany({ where: { serviceOrderId: id } }),
    prisma.vehicleDamage.deleteMany({ where: { serviceOrderId: id } }),
    prisma.timelineEvent.deleteMany({ where: { serviceOrderId: id } }),
    prisma.serviceOrder.delete({ where: { id } }),
  ]);

  res.json({ ok: true });
});
