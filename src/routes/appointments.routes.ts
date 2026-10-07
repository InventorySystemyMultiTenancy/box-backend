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
  deleteAppointment,
  getMechanicWorkload,
  getBayOccupancy,
  getMyPickupsToday,
  getDriverSchedule,
  AppointmentError,
} from "@/services/appointments.service";
import { hasPermission } from "@/services/permissions.service";
import { APPOINTMENT_STATUSES, APPOINTMENT_TYPES } from "@/lib/constants";

export const appointmentsRouter = Router();

const appointmentSchema = z.object({
  title: z.string().min(1),
  vehicleId: z.string().optional(),
  clientId: z.string().optional(),
  serviceOrderId: z.string().optional(),
  mechanicId: z.string().optional(),
  bayId: z.string().optional(),
  type: z.enum(APPOINTMENT_TYPES).optional(),
  driverId: z.string().optional(),
  startAt: z.string().datetime(),
  estimatedDurationMin: z.number().int().min(5).max(24 * 60).optional(),
  notes: z.string().optional(),
  pickupLocation: z.string().optional(),
  dropoffLocation: z.string().optional(),
});

const statusSchema = z.object({ status: z.enum(APPOINTMENT_STATUSES) });

appointmentsRouter.get("/", requireAuth, requirePermission("agenda", "view"), async (req, res) => {
  const appointments = await listAppointments(req.query as Record<string, unknown>);
  res.json({ appointments });
});

// Agendamentos de retirada/entrega do próprio usuário, hoje — usado pelo banner na
// aba Caminhões. De propósito sem requirePermission("agenda"): um motorista cujo
// cargo só mostra a aba Caminhões (ver Role.allowedTabs) ainda precisa ver isso.
appointmentsRouter.get("/my-pickups-today", requireAuth, async (req: AuthedRequest, res) => {
  const appointments = await getMyPickupsToday(req.user!.id);
  res.json({ appointments });
});

// Planilha de agendamento dos motoristas (?from=&to=&driverId=). Quem tem a agenda
// (agenda.view) vê todos ou filtra por motorista; o motorista sem acesso à Agenda (cargo
// que só vê Caminhões) recebe só os agendamentos dele, seja qual for o driverId pedido.
appointmentsRouter.get("/driver-schedule", requireAuth, async (req: AuthedRequest, res) => {
  const canSeeAll = await hasPermission(req.user!.id, "agenda", "view");
  const requestedDriver = typeof req.query.driverId === "string" && req.query.driverId ? req.query.driverId : undefined;
  const appointments = await getDriverSchedule({
    from: typeof req.query.from === "string" ? req.query.from : undefined,
    to: typeof req.query.to === "string" ? req.query.to : undefined,
    driverId: canSeeAll ? requestedDriver : req.user!.id,
  });
  res.json({ appointments, scope: canSeeAll ? "all" : "own" });
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

// Na edição, null = limpar o campo (ex.: tirar o mecânico, apagar a observação).
const updateAppointmentSchema = appointmentSchema.partial().extend({
  vehicleId: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
  serviceOrderId: z.string().nullable().optional(),
  mechanicId: z.string().nullable().optional(),
  bayId: z.string().nullable().optional(),
  driverId: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  pickupLocation: z.string().nullable().optional(),
  dropoffLocation: z.string().nullable().optional(),
});

appointmentsRouter.patch("/:id", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  const parsed = updateAppointmentSchema.safeParse(req.body);
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

appointmentsRouter.delete("/:id", requireAuth, requirePermission("agenda", "manage"), async (req: AuthedRequest<{ id: string }>, res) => {
  try {
    await deleteAppointment(req.params.id);
    res.status(204).send();
  } catch (err) {
    if (err instanceof AppointmentError) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
