import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listSectors, createSector, updateSector, archiveSector, SectorError } from "@/services/sectors.service";

export const sectorsRouter = Router();

const sectorSchema = z.object({
  name: z.string().min(1),
  storeId: z.string().optional(),
});

sectorsRouter.get("/", requireAuth, async (req, res) => {
  const sectors = await listSectors(req.query as Record<string, unknown>);
  res.json({ sectors });
});

sectorsRouter.post("/", requireAuth, requirePermission("sectors", "manage"), async (req, res) => {
  const parsed = sectorSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const sector = await createSector(parsed.data);
  res.status(201).json({ sector });
});

sectorsRouter.patch("/:id", requireAuth, requirePermission("sectors", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = sectorSchema.partial().extend({ active: z.coerce.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const sector = await updateSector(req.params.id, parsed.data);
    res.json({ sector });
  } catch (err) {
    if (err instanceof SectorError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

sectorsRouter.delete("/:id", requireAuth, requirePermission("sectors", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveSector(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof SectorError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
