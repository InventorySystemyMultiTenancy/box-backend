import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthedRequest } from "@/middleware/auth";
import { requirePermission } from "@/middleware/permissions";
import {
  listAppointments,
  getAppointmentDetail,
  createAppointment,
  updateAppointment,
  setAppointmentStatus,
  getMechanicWorkload,
  getBayOccupancy,
  AppointmentError,
} from "@/services/appointments.service";
import { APPOINTMENT_STATUSES } from "@/lib/constants";

export const appointmentsRouter = Router();

const appointmentSchema = z.object({
  title: z.string().min(1),
  vehicleId: z.string().optional(),
  clientId: z.string().optional(),
  serviceOrderId: z.string().optional(),
  mechanicId: z.string().optional(),
  bayId: z.string().optional(),
  startAt: z.string().datetime(),
  estimatedDurationMin: z.number().int().min(5).max(24 * 60).optional(),
  notes: z.string().optional(),
});

const statusSchema = z.object({ status: z.enum(APPOINTMENT_STATUSES) });

appointmentsRouter.get("/", requireAuth, requirePermission("agenda", "view"), async (req, res) => {
  const appointments = await listAppointments(req.query as Record<string, unknown>);
  res.json({ appointments });
});

appointmentsRouter.get("/workload", requireAuth, requirePermission("agenda", "view"), async (req, res) => {
  const workload = await getMechanicWorkload(req.query as { from?: string; to?: string });
  res.json({ workload });
});

appointmentsRouter.get("/bay-occupancy", requireAuth, requirePermission("agenda", "view"), async (req, res) => {
  const occupancy = await getBayOccupancy(req.query as { from?: string; to?: string });
  res.json({ occupancy });
});

appointmentsRouter.get("/:id", requireAuth, requirePermission("agenda", "view"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    const appointment = await getAppointmentDetail(req.params.id);
    res.json({ appointment });
  } catch (err) {
    if (err instanceof AppointmentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

appointmentsRouter.post("/", requireAuth, requirePermission("agenda", "manage"), async (req, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const appointment = await createAppointment(parsed.data);
    res.status(201).json({ appointment });
  } catch (err) {
    if (err instanceof AppointmentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

appointmentsRouter.patch("/:id", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = appointmentSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Dados inválidos.", details: parsed.error.flatten() });

  try {
    const appointment = await updateAppointment(req.params.id, parsed.data);
    res.json({ appointment });
  } catch (err) {
    if (err instanceof AppointmentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

appointmentsRouter.patch("/:id/status", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Status inválido." });

  try {
    const appointment = await setAppointmentStatus(req.params.id, parsed.data.status);
    res.json({ appointment });
  } catch (err) {
    if (err instanceof AppointmentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
