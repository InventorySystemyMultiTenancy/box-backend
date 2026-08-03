import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { canAccessServiceOrder } from "@/lib/authorization";
import { emitToOrder } from "@/sockets";
import { upload, guessMediaType, persistUploadedFile } from "@/middleware/upload";
import { PART_KEYS, PART_STATUSES, STATUS_PROGRESS } from "@/lib/constants";

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

const problemSchema = z.object({
  key: z.enum(PART_KEYS),
  name: z.string().min(1),
  description: z.string().min(4),
  wearLevel: z.coerce.number().min(0).max(100).optional(),
  estimatedValue: z.coerce.number().min(0).optional(),
  laborValue: z.coerce.number().min(0).optional(),
  partUsages: z.string().optional(),
});

const usageSchema = z.array(z.object({
  inventoryPartId: z.string(),
  quantity: z.number().int().min(1),
}));

async function replacePartUsages(
  approvalId: string,
  rawUsages: string | undefined,
  // Prisma transaction client.
  tx: any
) {
  await tx.problemPartUsage.deleteMany({ where: { approvalId } });
  if (!rawUsages) return 0;

  const parsed = usageSchema.safeParse(JSON.parse(rawUsages));
  if (!parsed.success) throw new Error("PART_USAGE_INVALID");

  let partsValue = 0;
  for (const usage of parsed.data) {
    const inventoryPart = await tx.inventoryPart.findUnique({ where: { id: usage.inventoryPartId } });
    if (!inventoryPart || !inventoryPart.active) throw new Error("PART_NOT_FOUND");
    partsValue += inventoryPart.unitCost * usage.quantity;
    await tx.problemPartUsage.create({
      data: {
        approvalId,
        inventoryPartId: inventoryPart.id,
        quantity: usage.quantity,
        unitCostSnapshot: inventoryPart.unitCost,
      },
    });
  }
  return partsValue;
}

const priceProblemSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().min(4).optional(),
  laborValue: z.number().min(0).default(0),
  partUsages: usageSchema.default([]),
});

partsRouter.patch(
  "/problems/:approvalId/pricing",
  requireAuth,
  requireRole("ADMIN"),
  async (req: AuthedRequest<{ orderId: string; approvalId: string }>, res) => {
    const parsed = priceProblemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    const existing = await prisma.approval.findUnique({
      where: { id: req.params.approvalId },
      include: { part: true },
    });
    if (!existing || existing.serviceOrderId !== req.params.orderId || !existing.partId) {
      return res.status(404).json({ error: "Problema não encontrado nesta ordem." });
    }
    if (existing.status === "REJECTED") {
      return res.status(409).json({ error: "Não é possível precificar um problema reprovado." });
    }

    // Precificar um problema já aprovado (em andamento ou já concluído) só corrige o
    // valor registrado — não deve reabrir aprovação do cliente nem mexer no status da
    // ordem. Só o primeiro preço (problema ainda PENDING) dispara o fluxo de aprovação.
    const wasPending = existing.status === "PENDING";

    const result = await prisma.$transaction(async (tx) => {
      if (parsed.data.name || parsed.data.description) {
        await tx.vehiclePart.update({
          where: { id: existing.partId! },
          data: {
            name: parsed.data.name,
            note: parsed.data.description,
          },
        });
      }

      await tx.problemPartUsage.deleteMany({ where: { approvalId: existing.id } });
      let partsValue = 0;
      for (const usage of parsed.data.partUsages) {
        const inventoryPart = await tx.inventoryPart.findUnique({ where: { id: usage.inventoryPartId } });
        if (!inventoryPart || !inventoryPart.active) throw new Error("PART_NOT_FOUND");
        partsValue += inventoryPart.unitCost * usage.quantity;
        await tx.problemPartUsage.create({
          data: {
            approvalId: existing.id,
            inventoryPartId: inventoryPart.id,
            quantity: usage.quantity,
            unitCostSnapshot: inventoryPart.unitCost,
          },
        });
      }

      const description = parsed.data.description ?? existing.description;
      const approval = await tx.approval.update({
        where: { id: existing.id },
        data: {
          description: parsed.data.name ? `${parsed.data.name}: ${description}` : description,
          laborValue: parsed.data.laborValue,
          partsValue,
          estimatedValue: parsed.data.laborValue + partsValue,
        },
        include: { media: true, partUsages: { include: { inventoryPart: true } } },
      });

      const part = await tx.vehiclePart.findUnique({
        where: { id: existing.partId! },
        include: { media: true, responsible: { select: { name: true } } },
      });

      const event = await tx.timelineEvent.create({
        data: {
          serviceOrderId: req.params.orderId,
          title: wasPending ? "Problema precificado pelo admin" : "Preço do problema atualizado pelo admin",
          description: `Valor total: R$ ${(parsed.data.laborValue + partsValue).toFixed(2)}`,
          authorId: req.user!.id,
        },
        include: { media: true, author: { select: { name: true } } },
      });

      if (wasPending) {
        await tx.serviceOrder.update({
          where: { id: req.params.orderId },
          data: { status: "AWAITING_APPROVAL", progress: STATUS_PROGRESS.AWAITING_APPROVAL },
        });
      }

      return { approval, part, event };
    });

    emitToOrder(req.params.orderId, "approval:update", { approval: result.approval });
    if (result.part) emitToOrder(req.params.orderId, "part:update", { part: result.part });
    emitToOrder(req.params.orderId, "timeline:new", { event: result.event });
    if (wasPending) {
      emitToOrder(req.params.orderId, "status:update", {
        orderId: req.params.orderId,
        status: "AWAITING_APPROVAL",
        progress: STATUS_PROGRESS.AWAITING_APPROVAL,
      });
    }
    res.json(result);
  }
);

partsRouter.post(
  "/problems",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  upload.array("files", 12),
  async (req: AuthedRequest<{ orderId: string }>, res) => {
    const orderId = req.params.orderId;
    const allowed = await canAccessServiceOrder(req.user!.id, req.user!.role, orderId);
    if (!allowed) return res.status(403).json({ error: "Sem acesso a esta ordem de serviÃ§o." });

    const parsed = problemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados invÃ¡lidos.", details: parsed.error.flatten() });

    const files = Array.isArray(req.files) ? req.files : [];
    const { key, name, description, wearLevel } = parsed.data;
    const isAdmin = req.user!.role === "ADMIN";
    const laborValue = isAdmin ? parsed.data.laborValue ?? parsed.data.estimatedValue : undefined;
    const uploadedFiles = await Promise.all(
      files.map(async (file) => ({
        file,
        url: await persistUploadedFile(file),
      }))
    );

    const result = await prisma.$transaction(async (tx) => {
      const part = await tx.vehiclePart.upsert({
        where: { serviceOrderId_key: { serviceOrderId: orderId, key } },
        create: {
          serviceOrderId: orderId,
          key,
          name,
          status: "CRITICAL",
          note: description,
          wearLevel,
          responsibleId: req.user!.id,
        },
        update: {
          name,
          status: "CRITICAL",
          note: description,
          wearLevel,
          responsibleId: req.user!.id,
        },
      });

      const approval = await tx.approval.create({
        data: {
          serviceOrderId: orderId,
          partId: part.id,
          title: "Novo problema identificado",
          description: `${name}: ${description}`,
          laborValue,
          partsValue: 0,
          estimatedValue: laborValue,
          status: "PENDING",
        },
      });

      if (isAdmin && parsed.data.partUsages) {
        const partsValue = await replacePartUsages(approval.id, parsed.data.partUsages, tx);
        await tx.approval.update({
          where: { id: approval.id },
          data: {
            partsValue,
            estimatedValue: (laborValue ?? 0) + partsValue,
          },
        });
      }

      const event = await tx.timelineEvent.create({
        data: {
          serviceOrderId: orderId,
          title: "Novo problema identificado",
          description: `${name}: ${description}`,
          authorId: req.user!.id,
        },
      });

      if (uploadedFiles.length > 0) {
        await tx.media.createMany({
          data: uploadedFiles.map(({ file, url }) => ({
            serviceOrderId: orderId,
            partId: part.id,
            approvalId: approval.id,
            timelineEventId: event.id,
            url,
            type: guessMediaType(file.mimetype),
            label: file.originalname,
          })),
        });
      }

      await tx.serviceOrder.update({
        where: { id: orderId },
        data: isAdmin
          ? { status: "AWAITING_APPROVAL", progress: STATUS_PROGRESS.AWAITING_APPROVAL }
          : { status: "DIAGNOSIS_DONE", progress: STATUS_PROGRESS.DIAGNOSIS_DONE },
      });

      const [partWithRelations, approvalWithMedia, eventWithRelations] = await Promise.all([
        tx.vehiclePart.findUnique({
          where: { id: part.id },
          include: { media: true, responsible: { select: { name: true } } },
        }),
        tx.approval.findUnique({ where: { id: approval.id }, include: { media: true, partUsages: { include: { inventoryPart: true } } } }),
        tx.timelineEvent.findUnique({
          where: { id: event.id },
          include: { media: true, author: { select: { name: true } } },
        }),
      ]);

      return { part: partWithRelations!, approval: approvalWithMedia!, event: eventWithRelations! };
    });

    emitToOrder(orderId, "part:update", { part: result.part });
    emitToOrder(orderId, "approval:new", { approval: result.approval });
    emitToOrder(orderId, "timeline:new", { event: result.event });
    emitToOrder(orderId, "status:update", {
      orderId,
      status: isAdmin ? "AWAITING_APPROVAL" : "DIAGNOSIS_DONE",
      progress: isAdmin ? STATUS_PROGRESS.AWAITING_APPROVAL : STATUS_PROGRESS.DIAGNOSIS_DONE,
    });

    res.status(201).json(result);
  }
);

// O mecânico marca um problema (já aprovado e em reparo) como resolvido.
partsRouter.post(
  "/:partId/start",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ orderId: string; partId: string }>, res) => {
    const { orderId, partId } = req.params;

    const existing = await prisma.vehiclePart.findUnique({ where: { id: partId } });
    if (!existing || existing.serviceOrderId !== orderId) {
      return res.status(404).json({ error: "Componente nao encontrado nesta ordem de servico." });
    }

    const approval = await prisma.approval.findFirst({
      where: { serviceOrderId: orderId, partId },
      orderBy: { createdAt: "desc" },
    });
    if (approval && approval.status !== "APPROVED") {
      return res.status(409).json({ error: "Este problema precisa ser aprovado pelo cliente antes de iniciar a manutencao." });
    }

    const [part, event, order] = await prisma.$transaction([
      prisma.vehiclePart.update({
        where: { id: partId },
        data: { status: "IN_PROGRESS", responsibleId: req.user!.id },
        include: { media: true, responsible: { select: { name: true } } },
      }),
      prisma.timelineEvent.create({
        data: {
          serviceOrderId: orderId,
          title: `Manutencao iniciada: ${existing.name}`,
          description: "Reparo em andamento.",
          authorId: req.user!.id,
        },
        include: { media: true, author: { select: { name: true } } },
      }),
      prisma.serviceOrder.update({
        where: { id: orderId },
        data: { status: "IN_PROGRESS", progress: STATUS_PROGRESS.IN_PROGRESS },
      }),
    ]);

    emitToOrder(orderId, "part:update", { part });
    emitToOrder(orderId, "timeline:new", { event });
    emitToOrder(orderId, "status:update", { orderId, status: order.status, progress: order.progress });
    res.json({ part, event, order });
  }
);

partsRouter.post(
  "/:partId/resolve",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ orderId: string; partId: string }>, res) => {
    const { orderId, partId } = req.params;

    const existing = await prisma.vehiclePart.findUnique({ where: { id: partId } });
    if (!existing || existing.serviceOrderId !== orderId) {
      return res.status(404).json({ error: "Componente não encontrado nesta ordem de serviço." });
    }

    const [part, event] = await prisma.$transaction([
      prisma.vehiclePart.update({
        where: { id: partId },
        data: { status: "DONE", responsibleId: req.user!.id },
        include: { media: true, responsible: { select: { name: true } } },
      }),
      prisma.timelineEvent.create({
        data: {
          serviceOrderId: orderId,
          title: `Problema resolvido: ${existing.name}`,
          description: "Reparo concluído.",
          authorId: req.user!.id,
        },
        include: { media: true, author: { select: { name: true } } },
      }),
    ]);

    emitToOrder(orderId, "part:update", { part });
    emitToOrder(orderId, "timeline:new", { event });
    res.json({ part, event });
  }
);
