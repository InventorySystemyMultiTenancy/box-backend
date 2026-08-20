import { Router } from "express";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import { upload, persistUploadedFile } from "@/middleware/upload";

export const inventoryPartsRouter = Router();

const partSchema = z.object({
  name: z.string().min(2),
  sku: z.string().optional(),
  description: z.string().optional(),
  unitCost: z.coerce.number().min(0),
  stockQty: z.coerce.number().int().min(0),
  active: z.coerce.boolean().optional(),
});

inventoryPartsRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const parts = await prisma.inventoryPart.findMany({ orderBy: { name: "asc" } });
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
      photoUrl,
      active: parsed.data.active ?? true,
    },
  });
  res.status(201).json({ part });
});

inventoryPartsRouter.patch("/:id", requireAuth, requireRole("ADMIN"), upload.single("photo"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = partSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const photoUrl = req.file ? await persistUploadedFile(req.file) : undefined;
  const part = await prisma.inventoryPart.update({
    where: { id: req.params.id },
    data: {
      ...parsed.data,
      sku: parsed.data.sku || undefined,
      ...(photoUrl ? { photoUrl } : {}),
    },
  });
  res.json({ part });
});
