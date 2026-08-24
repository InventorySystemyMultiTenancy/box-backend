import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listServiceCatalog,
  createServiceCatalogItem,
  updateServiceCatalogItem,
  archiveServiceCatalogItem,
  ServiceCatalogError,
} from "@/services/service-catalog.service";

export const serviceCatalogRouter = Router();

const serviceSchema = z.object({
  code: z.string().optional(),
  category: z.string().optional(),
  name: z.string().min(2),
  description: z.string().optional(),
  standardTimeMin: z.coerce.number().int().min(0).optional(),
  hourlyRate: z.coerce.number().min(0).optional(),
  standardPrice: z.coerce.number().min(0).optional(),
  sector: z.string().optional(),
});

serviceCatalogRouter.get("/", requireAuth, requirePermission("services-catalog", "view"), async (req, res) => {
  const result = await listServiceCatalog(req.query as Record<string, unknown>);
  res.json(result);
});

serviceCatalogRouter.post("/", requireAuth, requirePermission("services-catalog", "manage"), async (req, res) => {
  const parsed = serviceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const item = await createServiceCatalogItem(parsed.data);
  res.status(201).json({ item });
});

serviceCatalogRouter.patch("/:id", requireAuth, requirePermission("services-catalog", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = serviceSchema.partial().extend({ active: z.coerce.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const item = await updateServiceCatalogItem(req.params.id, parsed.data);
    res.json({ item });
  } catch (err) {
    if (err instanceof ServiceCatalogError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

serviceCatalogRouter.delete("/:id", requireAuth, requirePermission("services-catalog", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveServiceCatalogItem(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ServiceCatalogError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
