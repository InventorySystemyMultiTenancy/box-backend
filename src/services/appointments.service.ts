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
  startAt: string;
  estimatedDurationMin?: number;
  notes?: string;
}

const include = {
  vehicle: true,
  client: true,
  serviceOrder: { select: { id: true, code: true, status: true } },
  mechanic: { select: { id: true, name: true } },
  bay: true,
} as const;

export async function listAppointments(query: Record<string, unknown>) {
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  const mechanicId = typeof query.mechanicId === "string" ? query.mechanicId : undefined;
  const bayId = typeof query.bayId === "string" ? query.bayId : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;

  return prisma.appointment.findMany({
    where: {
      ...(from || to ? { startAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(mechanicId ? { mechanicId } : {}),
      ...(bayId ? { bayId } : {}),
      ...(status ? { status } : {}),
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

  await assertNoConflict({ startAt, durationMin, mechanicId: input.mechanicId, bayId: input.bayId });

  return prisma.appointment.create({
    data: {
      title: input.title,
      vehicleId: input.vehicleId,
      clientId: input.clientId,
      serviceOrderId: input.serviceOrderId,
      mechanicId: input.mechanicId,
      bayId: input.bayId,
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

  if (input.startAt || input.estimatedDurationMin || input.mechanicId !== undefined || input.bayId !== undefined) {
    await assertNoConflict({ startAt, durationMin, mechanicId, bayId, excludeId: id });
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
  excludeId?: string;
}

// Busca candidatos num raio de 24h em torno do novo horário e filtra em memória —
// volume esperado por mecânico/box num dia é pequeno o bastante pra não precisar de SQL bruto.
async function assertNoConflict({ startAt, durationMin, mechanicId, bayId, excludeId }: ConflictCheck) {
  if (!mechanicId && !bayId) return;

  const newStart = startAt.getTime();
  const newEnd = newStart + durationMin * 60_000;
  const windowStart = new Date(newStart - 24 * 60 * 60_000);
  const windowEnd = new Date(newEnd + 24 * 60 * 60_000);

  const candidates = await prisma.appointment.findMany({
    where: {
      id: excludeId ? { not: excludeId } : undefined,
      status: { in: BLOCKING_STATUSES },
      startAt: { gte: windowStart, lte: windowEnd },
      OR: [...(mechanicId ? [{ mechanicId }] : []), ...(bayId ? [{ bayId }] : [])],
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
