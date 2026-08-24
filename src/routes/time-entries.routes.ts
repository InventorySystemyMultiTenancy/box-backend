import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, AuthedRequest } from "@/middleware/auth";
import {
  listTimeEntries,
  startTimeEntry,
  pauseTimeEntry,
  resumeTimeEntry,
  finishTimeEntry,
  getCapacityPanel,
  TimeEntryError,
} from "@/services/time-entries.service";

export const timeEntriesRouter = Router();

timeEntriesRouter.get("/capacity", requireAuth, requireRole("MECHANIC", "ADMIN"), async (_req, res) => {
  const panel = await getCapacityPanel();
  res.json(panel);
});

timeEntriesRouter.get("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req, res) => {
  const entries = await listTimeEntries(req.query as Record<string, unknown>);
  res.json({ entries });
});

const startSchema = z.object({
  employeeId: z.string().optional(),
  serviceOrderId: z.string().optional(),
  serviceId: z.string().optional(),
  sector: z.string().optional(),
  notes: z.string().optional(),
});

timeEntriesRouter.post("/", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const entry = await startTimeEntry({ ...parsed.data, employeeId: parsed.data.employeeId ?? req.user!.id });
    res.status(201).json({ entry });
  } catch (err) {
    if (err instanceof TimeEntryError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

timeEntriesRouter.patch("/:id/pause", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const entry = await pauseTimeEntry(req.params.id);
    res.json({ entry });
  } catch (err) {
    if (err instanceof TimeEntryError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

timeEntriesRouter.patch("/:id/resume", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const entry = await resumeTimeEntry(req.params.id);
    res.json({ entry });
  } catch (err) {
    if (err instanceof TimeEntryError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

timeEntriesRouter.patch("/:id/finish", requireAuth, requireRole("MECHANIC", "ADMIN"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = z.object({ notes: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos." });

  try {
    const entry = await finishTimeEntry(req.params.id, parsed.data.notes);
    res.json({ entry });
  } catch (err) {
    if (err instanceof TimeEntryError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
