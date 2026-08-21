import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listSuppliers,
  getSupplierDetail,
  createSupplier,
  updateSupplier,
  archiveSupplier,
  SupplierError,
} from "@/services/suppliers.service";

export const suppliersRouter = Router();

const supplierSchema = z.object({
  name: z.string().min(2),
  cpfCnpj: z.string().optional(),
  contactName: z.string().optional(),
  phone: z.string().optional(),
  whatsapp: z.string().optional(),
  email: z.string().email().optional().or(z.literal("")),
  addressLine: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  notes: z.string().optional(),
});

suppliersRouter.get("/", requireAuth, requirePermission("suppliers", "view"), async (req, res) => {
  const result = await listSuppliers(req.query as Record<string, unknown>);
  res.json(result);
});

suppliersRouter.get("/:id", requireAuth, requirePermission("suppliers", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const supplier = await getSupplierDetail(req.params.id);
    res.json({ supplier });
  } catch (err) {
    if (err instanceof SupplierError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

suppliersRouter.post("/", requireAuth, requirePermission("suppliers", "manage"), async (req, res) => {
  const parsed = supplierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  const supplier = await createSupplier(parsed.data);
  res.status(201).json({ supplier });
});

suppliersRouter.patch("/:id", requireAuth, requirePermission("suppliers", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = supplierSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const supplier = await updateSupplier(req.params.id, parsed.data);
    res.json({ supplier });
  } catch (err) {
    if (err instanceof SupplierError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

suppliersRouter.delete("/:id", requireAuth, requirePermission("suppliers", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await archiveSupplier(req.params.id);
    res.status(204).end();
  } catch (err) {
    if (err instanceof SupplierError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
