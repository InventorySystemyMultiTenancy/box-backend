import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { SERVICE_ORDER_STATUSES, STATUS_PROGRESS, STATUS_LABELS, SERVICE_ORDER_PRIORITIES, RETIRED_SERVICE_ORDER_STATUSES } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";
import { parsePageParams, paginated } from "@/lib/pagination";
import { upload, persistUploadedFile } from "@/middleware/upload";
import { recordAudit } from "@/services/audit.service";
import { createOrGetShareLink, revokeShareLink, getActiveShareLink, ShareLinkError } from "@/services/share-link.service";
import { createOrderReceivables, orderAlreadyBilled } from "@/services/service-order-billing.service";
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

// Listagens (Kanban, lista de projetos, histórico, seletores) só precisam do resumo — a
// timeline, fotos e peças completas vêm do GET /:id ao abrir o projeto. Carregar tudo de
// todas as ordens deixava a tela cada vez mais lenta conforme o histórico crescia.
const orderListInclude = {
  vehicle: { include: { owner: { select: { id: true, name: true, email: true, phone: true } } } },
  approvals: {
    orderBy: { createdAt: "desc" as const },
    select: { id: true, title: true, status: true, kind: true, laborValue: true, partsValue: true, estimatedValue: true, partId: true, createdAt: true },
  },
  consultant: { select: { id: true, name: true } },
  estimator: { select: { id: true, name: true } },
  technician: { select: { id: true, name: true } },
  currentSector: true,
  insuranceCompany: true,
};

const HISTORY_STATUSES = ["FINISHED", "READY_FOR_PICKUP"];

serviceOrdersRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const isStaff = req.user!.role === "MECHANIC" || req.user!.role === "ADMIN";
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
  const currentSectorId = typeof req.query.sectorId === "string" ? req.query.sectorId : undefined;
  const priority = typeof req.query.priority === "string" ? req.query.priority : undefined;
  const insuranceCompanyId = typeof req.query.insuranceCompanyId === "string" ? req.query.insuranceCompanyId : undefined;
  const includeArchived = req.query.includeArchived === "true";
  // scope=history: concluídos/com baixa, paginado e com busca no servidor (aba "Concluídos").
  const history = req.query.scope === "history";
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const where = {
    ...(isStaff ? {} : { vehicle: { ownerId: req.user!.id } }),
    // Projeto com baixa dada some da lista/kanban de projetos em andamento (staff),
    // mas segue acessível por GET /:id, histórico do cliente e busca — nunca é apagado.
    ...(history
      ? { OR: [{ archivedAt: { not: null } }, { status: { in: HISTORY_STATUSES } }] }
      : isStaff && !includeArchived
        ? { archivedAt: null }
        : {}),
    ...(q
      ? {
          AND: [
            {
              OR: [
                { code: { contains: q, mode: "insensitive" as const } },
                { vehicle: { plate: { contains: q, mode: "insensitive" as const } } },
                { vehicle: { brand: { contains: q, mode: "insensitive" as const } } },
                { vehicle: { model: { contains: q, mode: "insensitive" as const } } },
                { vehicle: { owner: { name: { contains: q, mode: "insensitive" as const } } } },
              ],
            },
          ],
        }
      : {}),
    ...(storeId ? { storeId } : {}),
    ...(currentSectorId ? { currentSectorId } : {}),
    ...(priority ? { priority } : {}),
    ...(insuranceCompanyId ? { insuranceCompanyId } : {}),
  };

  if (history) {
    const pageParams = parsePageParams(req.query as Record<string, unknown>);
    const [items, total] = await Promise.all([
      prisma.serviceOrder.findMany({
        where,
        include: orderListInclude,
        orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        skip: pageParams.skip,
        take: pageParams.take,
      }),
      prisma.serviceOrder.count({ where }),
    ]);
    const page = paginated(items.map((order) => hidePricesForMechanic(order, req.user!.role)), total, pageParams);
    return res.json({ orders: page.items, pagination: page.pagination });
  }

  const orders = await prisma.serviceOrder.findMany({ where, include: orderListInclude, orderBy: { createdAt: "desc" } });
  res.json({ orders: orders.map((order) => hidePricesForMechanic(order, req.user!.role)) });
});

const createOrderSchema = z.object({
  vehicleId: z.string(),
  estimatedMin: z.number().optional(),
  estimatedMax: z.number().optional(),
  scheduledAt: z.string().datetime().optional(),
  storeId: z.string().optional(),
  priority: z.enum(SERVICE_ORDER_PRIORITIES).optional(),
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
      priority: parsed.data.priority,
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

// Checklist de fotos de avaria pré-existente — enviado no form de novo projeto, antes
// de iniciar o reparo. Ficam salvas mesmo depois de o projeto ser finalizado/arquivado
// (Media nunca é limpa nesses fluxos), visíveis via botão dedicado em OrderDetail.
serviceOrdersRouter.post(
  "/:id/damage-photos",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.array("photos", 7),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) return res.status(400).json({ error: "Envie ao menos uma foto." });

    const uploaded = await Promise.all(files.map((file) => persistUploadedFile(file)));
    await prisma.media.createMany({
      data: uploaded.map((url) => ({
        serviceOrderId: order.id,
        url,
        type: "PHOTO" as const,
        label: "Foto de avaria pré-existente",
        isDamagePhoto: true,
      })),
    });

    const media = await prisma.media.findMany({ where: { serviceOrderId: order.id, isDamagePhoto: true }, orderBy: { createdAt: "asc" } });
    res.status(201).json({ media });
  }
);

// Assinatura do cliente desenhada na tela (PNG) — CHECKIN no laudo de entrada (junto das
// fotos de avaria) ou DELIVERY na retirada (também aceita junto do /finalize). Fica salva
// como mídia da OS, igual às fotos de avaria, mesmo depois de a OS ser arquivada.
serviceOrdersRouter.post(
  "/:id/signature",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.single("signature"),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const kind = z.enum(["CHECKIN", "DELIVERY"]).safeParse(req.body.kind);
    if (!kind.success) return res.status(400).json({ error: "Tipo de assinatura inválido." });
    if (!req.file || !req.file.mimetype.startsWith("image/")) return res.status(400).json({ error: "Envie a assinatura como imagem." });

    const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

    const url = await persistUploadedFile(req.file);
    const label = kind.data === "CHECKIN" ? "Assinatura do cliente — entrada do veículo" : "Assinatura do cliente — retirada do veículo";
    const media = await prisma.media.create({
      data: { serviceOrderId: order.id, url, type: "PHOTO", label, signatureKind: kind.data },
    });
    await prisma.timelineEvent.create({
      data: { serviceOrderId: order.id, title: label, authorId: req.user!.id },
    });

    emitToOrder(order.id, "media:new", { media });
    emitToOrder(order.id, "timeline:new", {});
    res.status(201).json({ media });
  }
);

serviceOrdersRouter.get("/:id", requireAuth, async (req: AuthedRequest<{ id: string }>, res) => {
  const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, req.params.id);
  if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviço." });

  const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id }, include: orderInclude });
  if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });
  res.json({ order: hidePricesForMechanic(order, req.user!.role) });
});

// Link público de acompanhamento (botão "Compartilhar" dentro do projeto) — deixa o
// cliente ver o andamento sem login, por até 30 dias. Resolvido publicamente (sem
// requireAuth) em GET /api/public/share/:token — ver public.routes.ts.
serviceOrdersRouter.get("/:id/share-link", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const link = await getActiveShareLink(req.params.id);
  res.json({ link: link ? { token: link.token, expiresAt: link.expiresAt } : null });
});

serviceOrdersRouter.post("/:id/share-link", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const link = await createOrGetShareLink(req.params.id, req.user!.id);
  res.status(201).json({ link: { token: link.token, expiresAt: link.expiresAt } });
});

serviceOrdersRouter.delete("/:id/share-link", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await revokeShareLink(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ShareLinkError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
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
    if (RETIRED_SERVICE_ORDER_STATUSES.has(status)) {
      return res.status(400).json({ error: "Esta etapa não é mais usada no fluxo." });
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

// multipart manda booleano como texto — z.coerce.boolean() trataria "false" como true.
const formBoolean = z.enum(["true", "false"]).transform((v) => v === "true");

const finalizeSchema = z.object({
  description: z.string().optional(),
  extraValue: z.coerce.number().min(0).optional(),
  // Cobrança gerada na entrega (Financeiro > Contas a receber).
  paymentMethod: z.string().optional(),
  installments: z.coerce.number().int().min(1).max(24).optional(),
  firstDueDate: z.string().optional(),
  receivedNow: formBoolean.optional(),
  bankAccountId: z.string().optional(),
});

// Admin finaliza e entrega o veículo: além de liberar a retirada, pode registrar uma
// foto extra do veículo pronto, a assinatura do cliente, uma descrição e um valor extra
// (ex.: lavagem, taxa de entrega) somado por fora dos preços dos problemas/peças. A
// cobrança vira conta a receber (à vista/parcelada, já recebida ou não) — antes era um
// lançamento de receita solto, que somava em dobro com a conta a receber da mesma OS.
serviceOrdersRouter.patch(
  "/:id/finalize",
  requireAuth,
  requireRole("ADMIN"),
  upload.fields([
    { name: "photo", maxCount: 1 },
    { name: "signature", maxCount: 1 },
  ]),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const parsed = finalizeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;

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

    const photoUrl = files.photo?.[0] ? await persistUploadedFile(files.photo[0]) : undefined;
    const signatureUrl = files.signature?.[0] ? await persistUploadedFile(files.signature[0]) : undefined;
    const { description, extraValue, ...payment } = parsed.data;

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
        include: { vehicle: { include: { owner: { include: { client: { select: { id: true } } } } } } },
      });

      // Receita = trabalho de fato concluído (peça com status DONE), aprovado ou não pelo
      // cliente (exceto o reprovado), + valor extra. Finalizar de novo uma OS já cobrada não
      // gera outra cobrança (ex.: corrigir a descrição da entrega).
      if (!(await orderAlreadyBilled(tx, order.id))) {
        await createOrderReceivables(tx, order, extraValue ?? 0, payment);
      }

      if (signatureUrl) {
        await tx.media.create({
          data: { serviceOrderId: order.id, url: signatureUrl, type: "PHOTO", label: "Assinatura do cliente — retirada do veículo", signatureKind: "DELIVERY" },
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

  await prisma.$transaction(async (tx) => {
    // Registros que existem por conta própria só perdem o vínculo com a OS (agenda pode
    // estar ligada a uma pilotagem de caminhão; apontamento de horas é do funcionário;
    // a solicitação de orçamento do cliente continua no histórico dele).
    await tx.appointment.updateMany({ where: { serviceOrderId: id }, data: { serviceOrderId: null } });
    await tx.timeEntry.updateMany({ where: { serviceOrderId: id }, data: { serviceOrderId: null } });
    await tx.quoteRequest.updateMany({ where: { serviceOrderId: id }, data: { serviceOrderId: null } });

    // Ordem importa: itens de orçamento referenciam aprovações; mídia referencia
    // problema/evento/vistoria/avaria; aprovações referenciam o componente.
    await tx.estimate.deleteMany({ where: { serviceOrderId: id } });
    await tx.media.deleteMany({ where: { serviceOrderId: id } });
    await tx.chatMessage.deleteMany({ where: { serviceOrderId: id } });
    await tx.approval.deleteMany({ where: { serviceOrderId: id } });
    await tx.vehiclePart.deleteMany({ where: { serviceOrderId: id } });
    await tx.inspection.deleteMany({ where: { serviceOrderId: id } });
    await tx.vehicleDamage.deleteMany({ where: { serviceOrderId: id } });
    await tx.timelineEvent.deleteMany({ where: { serviceOrderId: id } });
    await tx.serviceOrder.delete({ where: { id } });
  });

  res.json({ ok: true });
});
