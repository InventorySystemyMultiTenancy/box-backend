import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { emitToStaff, emitToUser } from "@/sockets";
import { PART_KEYS, STATUS_PROGRESS } from "@/lib/constants";
import { nextOrderCode } from "@/lib/order-code";

export const quoteRequestsRouter = Router();

const quoteRequestInclude = {
  customer: { select: { id: true, name: true, email: true, phone: true } },
  mechanic: { select: { id: true, name: true } },
  vehicle: true,
  serviceOrder: { select: { id: true, code: true, status: true } },
};

const PART_LABELS: Record<(typeof PART_KEYS)[number], string> = {
  motor: "Motor",
  freios: "Freios",
  suspensao: "Suspensão",
  transmissao: "Transmissão",
  escapamento: "Escapamento",
  eletrica: "Elétrica",
  arcondicionado: "Ar-condicionado",
  direcao: "Direção",
  pneus: "Pneus",
  bateria: "Bateria",
  arrefecimento: "Arrefecimento",
  combustivel: "Combustível",
  carroceria: "Carroceria",
};

function inferProblemKey(text: string): (typeof PART_KEYS)[number] {
  const normalized = text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

  if (/freio|pastilha|disco|abs|pedal/.test(normalized)) return "freios";
  if (/suspens|amortec|mola|batida|barulho.*roda|estalo/.test(normalized)) return "suspensao";
  if (/cambio|transmiss|embreagem|marcha/.test(normalized)) return "transmissao";
  if (/escap|catalis|silencioso|fumaca/.test(normalized)) return "escapamento";
  if (/eletric|luz|farol|lanterna|painel|alternador/.test(normalized)) return "eletrica";
  if (/ar.?cond|climat|ventila|compressor/.test(normalized)) return "arcondicionado";
  if (/direcao|volante|alinhamento/.test(normalized)) return "direcao";
  if (/pneu|roda|calibr|vibracao/.test(normalized)) return "pneus";
  if (/bateria|partida|arranque/.test(normalized)) return "bateria";
  if (/radiador|arrefec|agua|temperatura|superaque/.test(normalized)) return "arrefecimento";
  if (/combust|injecao|bomba|tanque/.test(normalized)) return "combustivel";
  if (/porta|vidro|lataria|parachoque|capo|carroceria/.test(normalized)) return "carroceria";
  return "motor";
}

function safeProblemKey(value: string | null | undefined, fallbackText: string): (typeof PART_KEYS)[number] {
  return PART_KEYS.includes(value as (typeof PART_KEYS)[number])
    ? (value as (typeof PART_KEYS)[number])
    : inferProblemKey(fallbackText);
}

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
  problemKey: z.enum(PART_KEYS).optional(),
  problemName: z.string().min(1).optional(),
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
  const problemKey = parsed.data.problemKey ?? inferProblemKey(`${parsed.data.problemName ?? ""} ${problemDescription}`);
  const problemName = parsed.data.problemName ?? PART_LABELS[problemKey];

  const request = await prisma.quoteRequest.create({
    data: {
      customer: { connect: { id: req.user!.id } },
      problemDescription,
      problemKey,
      problemName,
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
    const problemKey = safeProblemKey(existing.problemKey, `${existing.problemName ?? ""} ${existing.problemDescription}`);
    const problemName = existing.problemName ?? PART_LABELS[problemKey];

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
              description: `Agendado para ${scheduledDate.toLocaleString("pt-BR")}. Problema relatado: ${existing.problemDescription}`,
              authorId: req.user!.id,
            },
          },
          parts: {
            create: {
              key: problemKey,
              name: problemName,
              status: "CRITICAL",
              note: `Relatado pelo cliente na solicitação de orçamento: ${existing.problemDescription}`,
              responsibleId: req.user!.id,
            },
          },
        },
        include: { parts: true },
      });

      const initialPart = order.parts[0];
      await tx.approval.create({
        data: {
          serviceOrderId: order.id,
          partId: initialPart.id,
          title: "Problema relatado pelo cliente",
          description: existing.problemDescription,
          status: "PENDING",
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
