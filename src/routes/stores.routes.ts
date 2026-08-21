import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import { listStores, createStore, updateStore, archiveStore, StoreError } from "@/services/stores.service";

export const storesRouter = Router();

const storeSchema = z.object({
  name: z.string().min(2),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  phone: z.string().optional(),
});

storesRouter.get("/", requireAuth, requirePermission("stores", "view"), async (_req, res) => {
  const stores = await listStores();
  res.json({ stores });
});

storesRouter.post("/", requireAuth, requirePermission("stores", "manage"), async (req, res) => {
  const parsed = storeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const store = await createStore(parsed.data);
  res.status(201).json({ store });
});

storesRouter.patch("/:id", requireAuth, requirePermission("stores", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = storeSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const store = await updateStore(req.params.id, parsed.data);
    res.json({ store });
  } catch (err) {
    if (err instanceof StoreError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

storesRouter.delete("/:id", requireAuth, requirePermission("stores", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveStore(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof StoreError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
