import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder, serviceOrderVisibilityFilter } from "@/lib/authorization";
import { vehicleIdsMatchingPlate } from "@/lib/plate-search";
import { notifyOrderReady } from "@/services/whatsapp.service";
import { emitToOrder } from "@/sockets";
import { SERVICE_ORDER_STATUSES, STATUS_PROGRESS, STATUS_LABELS, SERVICE_ORDER_PRIORITIES, RETIRED_SERVICE_ORDER_STATUSES, MAX_DAMAGE_PHOTOS, MAX_DAMAGE_VIDEOS } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";
import { parsePageParams, paginated } from "@/lib/pagination";
import { upload, uploadDamageMedia, persistUploadedFile, guessMediaType } from "@/middleware/upload";
import { recordAudit } from "@/services/audit.service";
import { createOrGetShareLink, revokeShareLink, getActiveShareLink, ShareLinkError } from "@/services/share-link.service";
import { BILLABLE_ORDER_INCLUDE, billFinishedOrder, billOrderOnDelivery, resyncOrderReceivables } from "@/services/service-order-billing.service";
import { clearServiceOrderAlerts } from "@/services/alerts.service";
import { saveServiceOrderReportPdf } from "@/services/service-order-report.service";
export const serviceOrdersRouter = Router();

// Dono do veículo com o cadastro de cliente (CRM) — aparece e é editável dentro do projeto.
const OWNER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  client: { select: { id: true, name: true, phone: true, whatsapp: true, email: true, cpfCnpj: true } },
} as const;

const orderInclude = {
  vehicle: { include: { owner: { select: OWNER_SELECT } } },
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
  assignees: { orderBy: { createdAt: "asc" as const }, include: { user: { select: { id: true, name: true } } } },
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
  assignees: { orderBy: { createdAt: "asc" as const }, include: { user: { select: { id: true, name: true } } } },
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
  // Placa sem o traço ("abc1234" acha "ABC-1234") — o "contains" sozinho exigia o traço.
  const plateVehicleIds = q ? await vehicleIdsMatchingPlate(q) : [];

  const where = {
    // Admin vê todos; funcionário só os projetos associados a ele; cliente só os dele.
    ...serviceOrderVisibilityFilter(req.user!.id, req.user!.role),
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
                { ssNumber: { contains: q, mode: "insensitive" as const } },
                { vehicle: { plate: { contains: q, mode: "insensitive" as const } } },
                ...(plateVehicleIds.length ? [{ vehicleId: { in: plateVehicleIds } }] : []),
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
  ssNumber: z.string().trim().max(50).optional(),
  // Funcionários associados já na criação (só o admin escolhe; quem cria entra sozinho).
  assigneeIds: z.array(z.string()).optional(),
  // Seguro: seguradora existente (insuranceCompanyId) ou nova (newInsuranceCompanyName) + franquia.
  hasInsurance: z.boolean().optional(),
  insuranceCompanyId: z.string().nullable().optional(),
  newInsuranceCompanyName: z.string().trim().max(120).optional(),
  deductibleAmount: z.coerce.number().min(0).nullable().optional(),
});

class InsuranceInputError extends Error {}

/**
 * Normaliza os dados de seguro do projeto. Sem seguro, limpa seguradora/franquia/sinistro.
 * Com nome de seguradora nova, reaproveita uma ativa de mesmo nome ou cria o cadastro.
 */
async function resolveInsurance(input: {
  hasInsurance?: boolean;
  insuranceCompanyId?: string | null;
  newInsuranceCompanyName?: string;
  deductibleAmount?: number | null;
}) {
  if (input.hasInsurance === undefined) return null;
  if (!input.hasInsurance) {
    return { hasInsurance: false, insuranceCompanyId: null, deductibleAmount: null, claimNumber: null, authorizationNumber: null };
  }
  let insuranceCompanyId = input.insuranceCompanyId ?? null;
  const name = input.newInsuranceCompanyName?.trim();
  if (name) {
    const existing = await prisma.insuranceCompany.findFirst({
      where: { active: true, OR: [{ legalName: { equals: name, mode: "insensitive" } }, { tradeName: { equals: name, mode: "insensitive" } }] },
    });
    insuranceCompanyId = existing ? existing.id : (await prisma.insuranceCompany.create({ data: { legalName: name } })).id;
  } else if (insuranceCompanyId) {
    const company = await prisma.insuranceCompany.findUnique({ where: { id: insuranceCompanyId } });
    if (!company) throw new InsuranceInputError("Seguradora não encontrada.");
  }
  return { hasInsurance: true, insuranceCompanyId, deductibleAmount: input.deductibleAmount ?? null };
}

function insuranceSummary(order: { hasInsurance: boolean; deductibleAmount: unknown; insuranceCompany?: { legalName: string; tradeName: string | null } | null }) {
  if (!order.hasInsurance) return "Sem seguro";
  const company = order.insuranceCompany ? (order.insuranceCompany.tradeName ?? order.insuranceCompany.legalName) : "seguradora não informada";
  const value = order.deductibleAmount != null ? Number(order.deductibleAmount) : null;
  return `Com seguro — ${company}${value != null ? ` · franquia ${value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""}`;
}

// Seguradoras ativas para o form do projeto (sem exigir a permissão do módulo de seguradoras).
serviceOrdersRouter.get("/insurance-options", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const companies = await prisma.insuranceCompany.findMany({
    where: { active: true },
    select: { id: true, legalName: true, tradeName: true },
    orderBy: { legalName: "asc" },
  });
  res.json({ companies });
});

/** Só funcionários ativos (mecânico/admin) podem ser associados a um projeto. */
async function validStaffIds(ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: unique }, active: true, role: { in: ["MECHANIC", "ADMIN"] } },
    select: { id: true },
  });
  return users.length === unique.length ? unique : null;
}

serviceOrdersRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  // Quem cria (funcionário) já fica associado — senão o próprio projeto sumiria da lista dele.
  const requested = req.user!.role === "ADMIN" ? (parsed.data.assigneeIds ?? []) : [];
  const assigneeIds = await validStaffIds(req.user!.role === "MECHANIC" ? [req.user!.id, ...requested] : requested);
  if (!assigneeIds) return res.status(400).json({ error: "Funcionário inválido na associação do projeto." });

  let insurance: Awaited<ReturnType<typeof resolveInsurance>>;
  try {
    insurance = await resolveInsurance(parsed.data);
  } catch (err) {
    if (err instanceof InsuranceInputError) return res.status(400).json({ error: err.message });
    throw err;
  }

  const code = await nextOrderCode();
  const order = await prisma.serviceOrder.create({
    data: {
      code,
      vehicleId: parsed.data.vehicleId,
      assignees: { create: assigneeIds.map((userId) => ({ userId })) },
      estimatedMin: parsed.data.estimatedMin,
      estimatedMax: parsed.data.estimatedMax,
      scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : undefined,
      storeId: parsed.data.storeId,
      priority: parsed.data.priority,
      ssNumber: parsed.data.ssNumber || undefined,
      ...(insurance ?? {}),
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
  // Fotos e vídeos (campo "photos" por compatibilidade) — até 20 fotos e 5 vídeos por projeto.
  uploadDamageMedia.array("photos", MAX_DAMAGE_PHOTOS),
  async (req: AuthedRequest<{ id: string }>, res) => {
    const order = await prisma.serviceOrder.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) return res.status(400).json({ error: "Envie ao menos uma foto ou vídeo." });

    const newVideos = files.filter((file) => file.mimetype.startsWith("video/")).length;
    const newPhotos = files.length - newVideos;
    const [photoCount, videoCount] = await Promise.all([
      prisma.media.count({ where: { serviceOrderId: order.id, isDamagePhoto: true, type: "PHOTO" } }),
      prisma.media.count({ where: { serviceOrderId: order.id, isDamagePhoto: true, type: "VIDEO" } }),
    ]);
    if (photoCount + newPhotos > MAX_DAMAGE_PHOTOS) {
      return res.status(400).json({ error: `O checklist de entrada aceita até ${MAX_DAMAGE_PHOTOS} fotos.` });
    }
    if (videoCount + newVideos > MAX_DAMAGE_VIDEOS) {
      return res.status(400).json({ error: `O checklist de entrada aceita até ${MAX_DAMAGE_VIDEOS} vídeos.` });
    }

    const uploaded = await Promise.all(files.map(async (file) => ({ file, url: await persistUploadedFile(file) })));
    await prisma.media.createMany({
      data: uploaded.map(({ file, url }) => {
        const type = guessMediaType(file.mimetype);
        return {
          serviceOrderId: order.id,
          url,
          type,
          label: type === "VIDEO" ? "Vídeo de avaria pré-existente" : "Foto de avaria pré-existente",
          isDamagePhoto: true,
        };
      }),
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

const assigneesSchema = z.object({ userIds: z.array(z.string()) });

// Admin define quais funcionários estão associados ao projeto (vários ao mesmo tempo).
// Substitui a lista inteira; funcionário não-admin só enxerga projetos em que está nela.
serviceOrdersRouter.put("/:id/assignees", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = assigneesSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const existing = await prisma.serviceOrder.findUnique({ where: { id: req.params.id }, include: { assignees: true } });
  if (!existing) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const userIds = await validStaffIds(parsed.data.userIds);
  if (!userIds) return res.status(400).json({ error: "Só é possível associar funcionários ativos." });

  const before = existing.assignees.map((a) => a.userId);
  const added = userIds.filter((id) => !before.includes(id));
  const removed = before.filter((id) => !userIds.includes(id));

  const assignees = await prisma.$transaction(async (tx) => {
    await tx.serviceOrderAssignee.deleteMany({ where: { serviceOrderId: existing.id, userId: { in: removed } } });
    await tx.serviceOrderAssignee.createMany({ data: added.map((userId) => ({ serviceOrderId: existing.id, userId })) });
    const assignees = await tx.serviceOrderAssignee.findMany({
      where: { serviceOrderId: existing.id },
      orderBy: { createdAt: "asc" },
      include: { user: { select: { id: true, name: true } } },
    });
    if (added.length || removed.length) {
      await tx.timelineEvent.create({
        data: {
          serviceOrderId: existing.id,
          title: "Funcionários do projeto atualizados",
          description: assignees.length ? assignees.map((a) => a.user.name).join(", ") : "Nenhum funcionário associado",
          authorId: req.user!.id,
        },
      });
    }
    return assignees;
  });

  if (added.length || removed.length) {
    await recordAudit({
      userId: req.user!.id,
      action: "UPDATE",
      entity: "ServiceOrderAssignee",
      entityId: existing.id,
      before: { userIds: before },
      after: { userIds },
    });
    emitToOrder(existing.id, "timeline:new", {});
  }
  res.json({ assignees });
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
  ssNumber: z.string().trim().max(50).nullable().optional(),
  hasInsurance: z.boolean().optional(),
  newInsuranceCompanyName: z.string().trim().max(120).optional(),
});

// Campos de processo (Fase 1 do gap SIGMA): consultor/orçamentista/técnico, prioridade,
// previsão de entrega, setor físico e dados de seguro/sinistro. Distinto de /status
// (ciclo operacional) e /finalize (entrega) — não sobrepõe as rotas já existentes.
serviceOrdersRouter.patch("/:id/process", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = processSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const before = await prisma.serviceOrder.findUnique({ where: { id: req.params.id }, include: { insuranceCompany: true } });
  if (!before) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const { deliveryForecastAt, hasInsurance, newInsuranceCompanyName, ...rest } = parsed.data;
  let insurance: Awaited<ReturnType<typeof resolveInsurance>>;
  try {
    insurance = await resolveInsurance({ hasInsurance, newInsuranceCompanyName, insuranceCompanyId: rest.insuranceCompanyId, deductibleAmount: rest.deductibleAmount });
  } catch (err) {
    if (err instanceof InsuranceInputError) return res.status(400).json({ error: err.message });
    throw err;
  }
  if (insurance) Object.assign(rest, insurance);
  if (rest.ssNumber === "") rest.ssNumber = null;
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
      include: { insuranceCompany: true },
    });
    if (insurance) {
      const from = insuranceSummary(before);
      const to = insuranceSummary(updated);
      if (from !== to) {
        events.push({ title: "Dados de seguro alterados", description: `${from} → ${to}` });
        // Cobrança já gerada e ainda não recebida: passa a refletir a franquia nova.
        await resyncOrderReceivables(tx, updated.id);
      }
    }
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

const orderClientSchema = z.object({
  name: z.string().trim().min(2, "Informe o nome do cliente.").max(120),
  phone: z.string().trim().max(30).optional(),
  whatsapp: z.string().trim().max(30).optional(),
  email: z.string().trim().email("E-mail inválido.").optional().or(z.literal("")),
  cpfCnpj: z.string().trim().max(20).optional(),
});

// Dados do cliente editados de dentro do projeto: atualiza o usuário dono do veículo (nome
// que aparece no projeto/portal) e o cadastro de cliente (CRM) juntos — criando o cadastro
// se o dono ainda não tiver um. Vale para todos os veículos/projetos desse cliente.
serviceOrdersRouter.patch("/:id/client", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = orderClientSchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message;
    return res.status(400).json({ error: first ?? "Dados inválidos.", details: parsed.error.flatten() });
  }

  const order = await prisma.serviceOrder.findUnique({
    where: { id: req.params.id },
    select: { id: true, vehicle: { select: { owner: { select: { id: true, email: true, client: { select: { id: true } } } } } } },
  });
  if (!order) return res.status(404).json({ error: "Ordem de serviço não encontrada." });
  const owner = order.vehicle.owner;

  const { name, phone, whatsapp, cpfCnpj } = parsed.data;
  const email = parsed.data.email?.trim() || null;
  // E-mail é o login do portal: só troca se vier preenchido e não for de outro usuário.
  if (email && email.toLowerCase() !== owner.email.toLowerCase()) {
    const taken = await prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" }, id: { not: owner.id } }, select: { id: true } });
    if (taken) return res.status(409).json({ error: "Já existe outro usuário com este e-mail." });
  }

  const clientData = {
    name,
    phone: phone || null,
    whatsapp: whatsapp || null,
    email,
    cpfCnpj: cpfCnpj || null,
  };
  const updated = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: owner.id },
      data: { name, phone: phone || null, ...(email ? { email } : {}) },
    });
    if (owner.client) await tx.client.update({ where: { id: owner.client.id }, data: clientData });
    else await tx.client.create({ data: { ...clientData, userId: owner.id } });
    await tx.timelineEvent.create({
      data: { serviceOrderId: order.id, title: "Dados do cliente atualizados", description: name, authorId: req.user!.id },
    });
    return tx.user.findUniqueOrThrow({ where: { id: owner.id }, select: OWNER_SELECT });
  });

  emitToOrder(order.id, "timeline:new", {});
  res.json({ owner: updated });
});

const statusSchema = z.object({
  status: z.enum(SERVICE_ORDER_STATUSES),
  progress: z.coerce.number().min(0).max(100).optional(),
  // Observação opcional da etapa — vai para a timeline e para o PDF do projeto.
  note: z.string().trim().max(2000).optional(),
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
    const note = parsed.data.note || undefined;
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

      // Chegou em "Finalizado": o valor do projeto já entra em contas a receber (pendente),
      // sem esperar "pronto para retirada". Na entrega a cobrança é ajustada (ver /finalize).
      if (statusChanged && status === "FINISHED") await billFinishedOrder(tx, order.id);

      let event = null;
      if (statusChanged || photoUrl || note) {
        event = await tx.timelineEvent.create({
          data: {
            serviceOrderId: order.id,
            title: statusChanged
              ? `Etapa avançada: ${STATUS_LABELS[status]}`
              : photoUrl
                ? `Foto adicionada — ${STATUS_LABELS[status]}`
                : `Observação — ${STATUS_LABELS[status]}`,
            description: note ? `Observação: ${note}` : undefined,
            note,
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
    // Chegou em "Finalizado": sai do andamento, então os alertas do projeto saem também.
    if (order.status === "FINISHED") await clearServiceOrderAlerts(prisma, order.id);
    // Aviso de veículo pronto no WhatsApp (equipe + cliente) — em segundo plano.
    if (order.status === "FINISHED" && statusChanged) void notifyOrderReady(order.id, req.user!.id);

    emitToOrder(order.id, "status:update", { orderId: order.id, status: order.status, progress: order.progress });
    if (event) emitToOrder(order.id, "timeline:new", { event });
    res.json({ order, event });
  }
);

const finalizeSchema = z.object({
  description: z.string().optional(),
  extraValue: z.coerce.number().min(0).optional(),
  // Cobrança gerada na entrega (Financeiro > Contas a receber).
  paymentMethod: z.string().optional(),
  installments: z.coerce.number().int().min(1).max(24).optional(),
  firstDueDate: z.string().optional(),
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
        include: BILLABLE_ORDER_INCLUDE,
      });

      // Receita = trabalho de fato concluído (peça com status DONE), aprovado ou não pelo
      // cliente (exceto o reprovado), + valor extra — sempre pendente (recebe no Financeiro).
      // Já cobrada ao chegar em "Finalizado": ajusta com as condições da entrega, sem duplicar.
      await billOrderOnDelivery(tx, order, extraValue ?? 0, payment);

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

      // Entrega na timeline, com a observação digitada (também listada no PDF do projeto).
      const note = description?.trim() || undefined;
      await tx.timelineEvent.create({
        data: {
          serviceOrderId: order.id,
          title: `Etapa avançada: ${STATUS_LABELS.READY_FOR_PICKUP}`,
          description: note ? `Observação: ${note}` : undefined,
          note,
          authorId: req.user!.id,
        },
      });

      // Projeto entregue não é mais pendência — alertas dele saem da aba Alertas.
      await clearServiceOrderAlerts(tx, order.id);

      return order;
    });

    // PDF de finalização (vai no WhatsApp da entrega). Falhar aqui não desfaz a entrega —
    // o admin ainda consegue o PDF pelo botão "Baixar PDF do projeto".
    let reportUrl: string | null = null;
    try {
      reportUrl = (await saveServiceOrderReportPdf(order.id)).url;
    } catch (err) {
      console.error("Falha ao gerar o PDF de finalização", err);
    }

    // Aviso de veículo pronto no WhatsApp (equipe + cliente) — em segundo plano.
    void notifyOrderReady(order.id, req.user!.id);

    const finalized = await prisma.serviceOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    emitToOrder(finalized.id, "status:update", { orderId: finalized.id, status: finalized.status, progress: finalized.progress });
    emitToOrder(finalized.id, "timeline:new", {});
    res.json({ order: finalized, reportUrl });
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
  await clearServiceOrderAlerts(prisma, order.id);

  emitToOrder(order.id, "service-order:archived", { orderId: order.id, archivedAt: order.archivedAt });
  res.json({ order: hidePricesForMechanic(order, req.user!.role) });
});

// Exclusão definitiva do projeto (diferente de "dar baixa", que só encerra e mantém o
// histórico). Projeto em andamento com rastro financeiro (comissão, nota fiscal, conta a
// receber ou lançamento) é recusado — use "Dar baixa". Projeto já finalizado (finalizado,
// pronto para retirada ou com baixa) pode ser excluído mesmo assim (ex.: projeto de
// teste): o rastro financeiro dele sai junto. Saldos de banco são calculados a partir
// dos lançamentos, então não ficam inconsistentes. Em todos os casos apaga em cascata
// tudo que só existe em função deste projeto (timeline, peças, aprovações, mídia, chat,
// orçamentos formais, vistorias, avarias).
serviceOrdersRouter.delete("/:id", requireAuth, requireRole("ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const { id } = req.params;
  const existing = await prisma.serviceOrder.findUnique({ where: { id } });
  if (!existing) return res.status(404).json({ error: "Ordem de serviço não encontrada." });

  const finished = Boolean(existing.archivedAt) || HISTORY_STATUSES.includes(existing.status);
  if (!finished) {
    const [commissions, invoices, receivables, financialEntries] = await Promise.all([
      prisma.commission.count({ where: { serviceOrderId: id } }),
      prisma.invoice.count({ where: { serviceOrderId: id } }),
      prisma.accountReceivable.count({ where: { serviceOrderId: id } }),
      prisma.financialEntry.count({ where: { serviceOrderId: id } }),
    ]);
    if (commissions > 0 || invoices > 0 || receivables > 0 || financialEntries > 0) {
      return res.status(409).json({
        error: "Este projeto em andamento já tem comissão, nota fiscal, conta a receber ou lançamento financeiro vinculado — não pode ser excluído. Use \"Dar baixa\" para encerrá-lo; depois de finalizado, ele pode ser excluído definitivamente.",
      });
    }
  }

  await recordAudit({
    userId: req.user!.id,
    action: "DELETE",
    entity: "ServiceOrder",
    entityId: id,
    before: existing,
  });

  await prisma.$transaction(async (tx) => {
    // Alertas do projeto saem junto (precisa ser antes de apagar aprovações/vistorias).
    await clearServiceOrderAlerts(tx, id);

    // Registros que existem por conta própria só perdem o vínculo com a OS (agenda pode
    // estar ligada a uma pilotagem de caminhão; apontamento de horas é do funcionário;
    // a solicitação de orçamento do cliente continua no histórico dele).
    // Rastro financeiro (só existe aqui se o projeto já estava finalizado — ver acima).
    // Comissão paga vira conta a pagar do mecânico: sai junto. Contas a pagar de nota de
    // fornecedor ligada ao projeto ficam (dinheiro pago de verdade a terceiros), só
    // perdem o vínculo com a nota apagada.
    const commissions = await tx.commission.findMany({ where: { serviceOrderId: id }, select: { accountPayableId: true } });
    const commissionPayableIds = commissions.map((c) => c.accountPayableId).filter((v): v is string => Boolean(v));
    await tx.commission.deleteMany({ where: { serviceOrderId: id } });
    if (commissionPayableIds.length) await tx.accountPayable.deleteMany({ where: { id: { in: commissionPayableIds } } });

    const receivableIds = (await tx.accountReceivable.findMany({ where: { serviceOrderId: id }, select: { id: true } })).map((r) => r.id);
    const invoiceIds = (
      await tx.invoice.findMany({
        where: { OR: [{ serviceOrderId: id }, ...(receivableIds.length ? [{ accountReceivableId: { in: receivableIds } }] : [])] },
        select: { id: true },
      })
    ).map((i) => i.id);
    if (invoiceIds.length) {
      await tx.accountPayable.updateMany({ where: { invoiceId: { in: invoiceIds } }, data: { invoiceId: null } });
      await tx.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    }

    const approvalIds = (await tx.approval.findMany({ where: { serviceOrderId: id }, select: { id: true } })).map((a) => a.id);
    await tx.financialEntry.deleteMany({
      where: { OR: [{ serviceOrderId: id }, ...(approvalIds.length ? [{ approvalId: { in: approvalIds } }, { partUsage: { approvalId: { in: approvalIds } } }] : [])] },
    });
    if (receivableIds.length) {
      await tx.counterSale.updateMany({ where: { accountReceivableId: { in: receivableIds } }, data: { accountReceivableId: null } });
      await tx.accountReceivable.deleteMany({ where: { id: { in: receivableIds } } });
    }

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
