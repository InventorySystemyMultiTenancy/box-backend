import { prisma } from "@/lib/prisma";

export class AppointmentError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// Status que efetivamente ocupam a agenda de um mecânico/box — cancelados e
// no-shows liberam o horário para reagendamento.
const BLOCKING_STATUSES = ["SCHEDULED", "CONFIRMED", "IN_PROGRESS"];

export interface AppointmentInput {
  title: string;
  vehicleId?: string;
  clientId?: string;
  serviceOrderId?: string;
  mechanicId?: string;
  bayId?: string;
  type?: string;
  driverId?: string;
  startAt: string;
  estimatedDurationMin?: number;
  notes?: string;
}

const include = {
  vehicle: true,
  client: true,
  serviceOrder: { select: { id: true, code: true, status: true } },
  mechanic: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true } },
  bay: true,
} as const;

const PICKUP_DROPOFF_TYPES = ["PICKUP", "DROPOFF"];

// Sem infra de cron no projeto (ver alerts.service.ts) — mesmo padrão aqui: recalcula
// sob demanda, toda vez que a agenda é lida. Retirada/entrega cujo dia já passou e
// ninguém finalizou manualmente vira DONE automaticamente.
export async function autoCompletePastAppointments() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  await prisma.appointment.updateMany({
    where: {
      type: { in: PICKUP_DROPOFF_TYPES },
      status: { in: BLOCKING_STATUSES },
      startAt: { lt: startOfToday },
    },
    data: { status: "DONE" },
  });
}

export async function listAppointments(query: Record<string, unknown>) {
  await autoCompletePastAppointments();

  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  const mechanicId = typeof query.mechanicId === "string" ? query.mechanicId : undefined;
  const driverId = typeof query.driverId === "string" ? query.driverId : undefined;
  const bayId = typeof query.bayId === "string" ? query.bayId : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const type = typeof query.type === "string" ? query.type : undefined;

  return prisma.appointment.findMany({
    where: {
      ...(from || to ? { startAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(mechanicId ? { mechanicId } : {}),
      ...(driverId ? { driverId } : {}),
      ...(bayId ? { bayId } : {}),
      ...(status ? { status } : {}),
      ...(type ? { type } : {}),
    },
    include,
    orderBy: { startAt: "asc" },
  });
}

// Agendamentos de retirada/entrega do próprio motorista, para hoje — usado pelo
// banner na aba Caminhões. Não exige permissão de agenda: qualquer funcionário
// autenticado pode ver os que são dele.
export async function getMyPickupsToday(driverId: string) {
  await autoCompletePastAppointments();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  return prisma.appointment.findMany({
    where: {
      driverId,
      type: { in: PICKUP_DROPOFF_TYPES },
      status: { in: BLOCKING_STATUSES },
      startAt: { gte: startOfToday, lt: endOfToday },
    },
    include,
    orderBy: { startAt: "asc" },
  });
}

export async function getAppointmentDetail(id: string) {
  const appointment = await prisma.appointment.findUnique({ where: { id }, include });
  if (!appointment) throw new AppointmentError("Agendamento não encontrado.", 404);
  return appointment;
}

export async function createAppointment(input: AppointmentInput) {
  const startAt = new Date(input.startAt);
  const durationMin = input.estimatedDurationMin ?? 60;

  await assertNoConflict({ startAt, durationMin, mechanicId: input.mechanicId, bayId: input.bayId, driverId: input.driverId });

  return prisma.appointment.create({
    data: {
      title: input.title,
      vehicleId: input.vehicleId,
      clientId: input.clientId,
      serviceOrderId: input.serviceOrderId,
      mechanicId: input.mechanicId,
      bayId: input.bayId,
      type: input.type ?? "SERVICE",
      driverId: input.driverId,
      startAt,
      estimatedDurationMin: durationMin,
      notes: input.notes,
    },
    include,
  });
}

export async function updateAppointment(id: string, input: Partial<AppointmentInput>) {
  const existing = await prisma.appointment.findUnique({ where: { id } });
  if (!existing) throw new AppointmentError("Agendamento não encontrado.", 404);

  const startAt = input.startAt ? new Date(input.startAt) : existing.startAt;
  const durationMin = input.estimatedDurationMin ?? existing.estimatedDurationMin;
  const mechanicId = input.mechanicId !== undefined ? input.mechanicId : existing.mechanicId ?? undefined;
  const bayId = input.bayId !== undefined ? input.bayId : existing.bayId ?? undefined;
  const driverId = input.driverId !== undefined ? input.driverId : existing.driverId ?? undefined;

  if (input.startAt || input.estimatedDurationMin || input.mechanicId !== undefined || input.bayId !== undefined || input.driverId !== undefined) {
    await assertNoConflict({ startAt, durationMin, mechanicId, bayId, driverId, excludeId: id });
  }

  return prisma.appointment.update({
    where: { id },
    data: {
      ...input,
      startAt,
      estimatedDurationMin: durationMin,
    },
    include,
  });
}

export async function setAppointmentStatus(id: string, status: string) {
  const existing = await prisma.appointment.findUnique({ where: { id } });
  if (!existing) throw new AppointmentError("Agendamento não encontrado.", 404);
  return prisma.appointment.update({ where: { id }, data: { status }, include });
}

interface ConflictCheck {
  startAt: Date;
  durationMin: number;
  mechanicId?: string;
  bayId?: string;
  driverId?: string;
  excludeId?: string;
}

// Busca candidatos num raio de 24h em torno do novo horário e filtra em memória —
// volume esperado por mecânico/box/motorista num dia é pequeno o bastante pra não
// precisar de SQL bruto.
async function assertNoConflict({ startAt, durationMin, mechanicId, bayId, driverId, excludeId }: ConflictCheck) {
  if (!mechanicId && !bayId && !driverId) return;

  const newStart = startAt.getTime();
  const newEnd = newStart + durationMin * 60_000;
  const windowStart = new Date(newStart - 24 * 60 * 60_000);
  const windowEnd = new Date(newEnd + 24 * 60 * 60_000);

  const candidates = await prisma.appointment.findMany({
    where: {
      id: excludeId ? { not: excludeId } : undefined,
      status: { in: BLOCKING_STATUSES },
      startAt: { gte: windowStart, lte: windowEnd },
      OR: [...(mechanicId ? [{ mechanicId }] : []), ...(bayId ? [{ bayId }] : []), ...(driverId ? [{ driverId }] : [])],
    },
  });

  for (const candidate of candidates) {
    const candidateStart = candidate.startAt.getTime();
    const candidateEnd = candidateStart + candidate.estimatedDurationMin * 60_000;
    const overlaps = candidateStart < newEnd && candidateEnd > newStart;
    if (!overlaps) continue;
    if (mechanicId && candidate.mechanicId === mechanicId) {
      throw new AppointmentError("Este mecânico já tem um agendamento nesse horário.", 409);
    }
    if (bayId && candidate.bayId === bayId) {
      throw new AppointmentError("Este box/elevador já está ocupado nesse horário.", 409);
    }
    if (driverId && candidate.driverId === driverId) {
      throw new AppointmentError("Este motorista já tem um agendamento nesse horário.", 409);
    }
  }
}

export interface PeriodQuery {
  from?: string;
  to?: string;
}

// Carga de trabalho por mecânico: total de agendamentos e minutos estimados no período.
export async function getMechanicWorkload({ from, to }: PeriodQuery) {
  const appointments = await prisma.appointment.findMany({
    where: {
      mechanicId: { not: null },
      status: { in: BLOCKING_STATUSES.concat("DONE") },
      ...(from || to ? { startAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    include: { mechanic: { select: { id: true, name: true } } },
  });

  const byMechanic = new Map<string, { mechanicId: string; mechanicName: string; appointments: number; totalMinutes: number }>();
  for (const a of appointments) {
    if (!a.mechanicId || !a.mechanic) continue;
    const bucket = byMechanic.get(a.mechanicId) ?? {
      mechanicId: a.mechanicId,
      mechanicName: a.mechanic.name,
      appointments: 0,
      totalMinutes: 0,
    };
    bucket.appointments += 1;
    bucket.totalMinutes += a.estimatedDurationMin;
    byMechanic.set(a.mechanicId, bucket);
  }

  return Array.from(byMechanic.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
}

// Ocupação de box/elevador num período — uma lista por bay, pronta pra renderizar
// como timeline/gantt visual.
export async function getBayOccupancy({ from, to }: PeriodQuery) {
  const bays = await prisma.bay.findMany({ where: { active: true }, orderBy: { name: "asc" } });
  const appointments = await prisma.appointment.findMany({
    where: {
      bayId: { not: null },
      status: { in: BLOCKING_STATUSES },
      ...(from || to ? { startAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    },
    include,
    orderBy: { startAt: "asc" },
  });

  return bays.map((bay) => ({
    bay,
    appointments: appointments.filter((a) => a.bayId === bay.id),
  }));
}
