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
});

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
    const { key, name, description, wearLevel, estimatedValue } = parsed.data;
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
          estimatedValue,
          status: "PENDING",
        },
      });

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
        data: { status: "AWAITING_APPROVAL", progress: STATUS_PROGRESS.AWAITING_APPROVAL },
      });

      const [partWithRelations, approvalWithMedia, eventWithRelations] = await Promise.all([
        tx.vehiclePart.findUnique({
          where: { id: part.id },
          include: { media: true, responsible: { select: { name: true } } },
        }),
        tx.approval.findUnique({ where: { id: approval.id }, include: { media: true } }),
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
    emitToOrder(orderId, "status:update", { orderId, status: "AWAITING_APPROVAL", progress: STATUS_PROGRESS.AWAITING_APPROVAL });

    res.status(201).json(result);
  }
);

// O mecânico marca um problema (já aprovado e em reparo) como resolvido.
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
