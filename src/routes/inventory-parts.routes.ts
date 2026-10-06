import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { upload, persistUploadedFile } from "@/middleware/upload";
import { recordAudit } from "@/services/audit.service";

export const inventoryPartsRouter = Router();

// Peça é só um item de catálogo com preço (unitCost) — usada em projetos e vendida no PDV.
// Não há controle de estoque: as colunas stockQty/minStockQty/reorderQty continuam no banco
// (dados antigos preservados), mas não são mais lidas nem gravadas pelo sistema.
const partSchema = z.object({
  name: z.string().min(2),
  sku: z.string().optional(),
  description: z.string().optional(),
  kind: z.enum(["PART", "MATERIAL"]).optional(),
  unitCost: z.coerce.number().min(0),
  preferredSupplierId: z.string().optional(),
  storeId: z.string().optional(),
  // Chega como texto (multipart) — z.coerce.boolean() trataria "false" como true.
  active: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
});

inventoryPartsRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
  const kind = req.query.kind === "PART" || req.query.kind === "MATERIAL" ? req.query.kind : undefined;
  const parts = await prisma.inventoryPart.findMany({ where: { ...(storeId ? { storeId } : {}), ...(kind ? { kind } : {}) }, orderBy: { name: "asc" } });
  if (req.user!.role === "MECHANIC") {
    return res.json({ parts: parts.map((part) => ({ ...part, unitCost: null })) });
  }
  res.json({ parts });
});

inventoryPartsRouter.post("/", requireAuth, requireRole("ADMIN"), upload.single("photo"), async (req, res) => {
  const parsed = partSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const photoUrl = req.file ? await persistUploadedFile(req.file) : undefined;
  const part = await prisma.inventoryPart.create({
    data: {
      ...parsed.data,
      sku: parsed.data.sku || undefined,
      preferredSupplierId: parsed.data.preferredSupplierId || undefined,
      storeId: parsed.data.storeId || undefined,
      photoUrl,
      active: parsed.data.active ?? true,
    },
  });
  res.status(201).json({ part });
});

inventoryPartsRouter.patch("/:id", requireAuth, requireRole("ADMIN"), upload.single("photo"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = partSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const before = await prisma.inventoryPart.findUnique({ where: { id: req.params.id } });
  const photoUrl = req.file ? await persistUploadedFile(req.file) : undefined;
  const part = await prisma.inventoryPart.update({
    where: { id: req.params.id },
    data: {
      ...parsed.data,
      sku: parsed.data.sku || undefined,
      preferredSupplierId: parsed.data.preferredSupplierId || undefined,
      storeId: parsed.data.storeId || undefined,
      ...(photoUrl ? { photoUrl } : {}),
    },
  });

  if (before && before.unitCost !== part.unitCost) {
    await recordAudit({
      userId: req.user!.id,
      action: "UPDATE",
      entity: "InventoryPart",
      entityId: part.id,
      before: { unitCost: before.unitCost },
      after: { unitCost: part.unitCost },
    });
  }

  res.json({ part });
});
