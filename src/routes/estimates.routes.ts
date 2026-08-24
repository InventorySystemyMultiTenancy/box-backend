import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import {
  listEstimates,
  getEstimateDetail,
  createEstimate,
  updateEstimate,
  updateEstimateStatus,
  addEstimateItem,
  removeEstimateItem,
  EstimateError,
} from "@/services/estimates.service";
import { ESTIMATE_STATUSES, ESTIMATE_ITEM_CLASSIFICATIONS } from "@/lib/constants";
import { recordAudit } from "@/services/audit.service";

export const estimatesRouter = Router();

const itemSchema = z.object({
  approvalId: z.string().optional(),
  description: z.string().min(1),
  classification: z.enum(ESTIMATE_ITEM_CLASSIFICATIONS).optional(),
  quantity: z.number().positive().optional(),
  unitValue: z.number().min(0).optional(),
});

const createSchema = z.object({
  serviceOrderId: z.string(),
  insuranceCompanyId: z.string().optional(),
  validUntil: z.string().datetime().optional(),
  materialsTotal: z.number().min(0).optional(),
  thirdPartyTotal: z.number().min(0).optional(),
  discountAmount: z.number().min(0).optional(),
  taxAmount: z.number().min(0).optional(),
  deductibleAmount: z.number().min(0).optional(),
  notes: z.string().optional(),
  items: z.array(itemSchema).optional(),
});

estimatesRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const estimates = await listEstimates(req.query as Record<string, unknown>);
  res.json({ estimates });
});

estimatesRouter.get("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const estimate = await getEstimateDetail(req.params.id);
    res.json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

estimatesRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const estimate = await createEstimate(parsed.data);
    res.status(201).json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

estimatesRouter.patch("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = createSchema.partial().omit({ serviceOrderId: true, items: true }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const estimate = await updateEstimate(req.params.id, parsed.data);
    res.json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

estimatesRouter.patch("/:id/status", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = z.object({ status: z.enum(ESTIMATE_STATUSES) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Status inválido." });

  try {
    const estimate = await updateEstimateStatus(req.params.id, parsed.data.status);
    await recordAudit({ userId: req.user!.id, action: "STATUS_CHANGE", entity: "Estimate", entityId: estimate.id, after: { status: estimate.status } });
    res.json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

estimatesRouter.post("/:id/items", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const estimate = await addEstimateItem(req.params.id, parsed.data);
    res.status(201).json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

estimatesRouter.delete("/:id/items/:itemId", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string; itemId: string }>, res) => {
  try {
    const estimate = await removeEstimateItem(req.params.id, req.params.itemId);
    res.json({ estimate });
  } catch (err) {
    if (err instanceof EstimateError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
