import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listBays, createBay, updateBay, archiveBay, BayError } from "@/services/bays.service";

export const baysRouter = Router();

const baySchema = z.object({
  name: z.string().min(1),
  type: z.enum(["BAY", "LIFT"]).optional(),
  storeId: z.string().optional(),
});

baysRouter.get("/", requireAuth, requirePermission("agenda", "view"), async (req, res) => {
  const storeId = typeof req.query.storeId === "string" ? req.query.storeId : undefined;
  const bays = await listBays(storeId);
  res.json({ bays });
});

baysRouter.post("/", requireAuth, requirePermission("agenda", "manage"), async (req, res) => {
  const parsed = baySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const bay = await createBay(parsed.data);
  res.status(201).json({ bay });
});

baysRouter.patch("/:id", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = baySchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const bay = await updateBay(req.params.id, parsed.data);
    res.json({ bay });
  } catch (err) {
    if (err instanceof BayError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

baysRouter.delete("/:id", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveBay(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof BayError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
