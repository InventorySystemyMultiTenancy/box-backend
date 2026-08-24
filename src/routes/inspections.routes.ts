import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import {
  listInspections,
  listInspectionsToSchedule,
  getInspectionDetail,
  createInspection,
  updateInspection,
  createInspectionIssue,
  updateInspectionIssue,
  listIrregularEstimates,
  InspectionError,
} from "@/services/inspections.service";
import { INSPECTION_STATUSES, INSPECTION_ISSUE_STATUSES } from "@/lib/constants";

export const inspectionsRouter = Router();

const createSchema = z.object({
  serviceOrderId: z.string(),
  insuranceCompanyId: z.string().optional(),
  inspectorId: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
  location: z.string().optional(),
  type: z.string().optional(),
  notes: z.string().optional(),
});

// Rotas estáticas antes de "/:id" para não colidir com o param.
inspectionsRouter.get("/to-schedule", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const orders = await listInspectionsToSchedule();
  res.json({ orders });
});

inspectionsRouter.get("/regularization", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const items = await listIrregularEstimates();
  res.json({ items });
});

inspectionsRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const inspections = await listInspections(req.query as Record<string, unknown>);
  res.json({ inspections });
});

inspectionsRouter.get("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const inspection = await getInspectionDetail(req.params.id);
    res.json({ inspection });
  } catch (err) {
    if (err instanceof InspectionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

inspectionsRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const inspection = await createInspection(parsed.data);
    res.status(201).json({ inspection });
  } catch (err) {
    if (err instanceof InspectionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const updateSchema = createSchema
  .omit({ serviceOrderId: true })
  .extend({ status: z.enum(INSPECTION_STATUSES).optional(), result: z.string().optional() });

inspectionsRouter.patch("/:id", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const inspection = await updateInspection(req.params.id, parsed.data);
    res.json({ inspection });
  } catch (err) {
    if (err instanceof InspectionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

const issueSchema = z.object({
  item: z.string().min(1),
  description: z.string().optional(),
  responsibleId: z.string().optional(),
  dueDate: z.string().datetime().optional(),
});

inspectionsRouter.post("/:id/issues", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const inspection = await createInspectionIssue(req.params.id, parsed.data);
    res.status(201).json({ inspection });
  } catch (err) {
    if (err instanceof InspectionError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

inspectionsRouter.patch(
  "/:id/issues/:issueId",
  requireAuth,
  requireRole("MECHANIC", "ADMIN"),
  async (req: AuthedRequest<{ id: string; issueId: string }>, res) => {
    const parsed = issueSchema
      .partial()
      .extend({ status: z.enum(INSPECTION_ISSUE_STATUSES).optional() })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

    try {
      const issue = await updateInspectionIssue(req.params.id, req.params.issueId, parsed.data);
      res.json({ issue });
    } catch (err) {
      if (err instanceof InspectionError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  }
);
