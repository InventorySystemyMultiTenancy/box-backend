import { prisma } from "@/lib/prisma";

export class TimeEntryError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface StartTimeEntryInput {
  employeeId: string;
  serviceOrderId?: string;
  serviceId?: string;
  sector?: string;
  notes?: string;
}

const timeEntryInclude = {
  employee: { select: { id: true, name: true } },
  serviceOrder: { select: { id: true, code: true } },
  service: { select: { id: true, name: true, standardTimeMin: true } },
};

export async function listTimeEntries(query: Record<string, unknown>) {
  const employeeId = typeof query.employeeId === "string" ? query.employeeId : undefined;
  const serviceOrderId = typeof query.serviceOrderId === "string" ? query.serviceOrderId : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;

  return prisma.timeEntry.findMany({
    where: {
      ...(employeeId ? { employeeId } : {}),
      ...(serviceOrderId ? { serviceOrderId } : {}),
      ...(status ? { status } : {}),
      ...(from || to ? { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    include: timeEntryInclude,
    orderBy: { startedAt: "desc" },
  });
}

export async function startTimeEntry(input: StartTimeEntryInput) {
  const running = await prisma.timeEntry.findFirst({ where: { employeeId: input.employeeId, status: { in: ["RUNNING", "PAUSED"] } } });
  if (running) throw new TimeEntryError("Já existe um apontamento em andamento para este funcionário.", 409);

  return prisma.timeEntry.create({ data: { ...input, status: "RUNNING" }, include: timeEntryInclude });
}

export async function pauseTimeEntry(id: string) {
  const entry = await prisma.timeEntry.findUnique({ where: { id } });
  if (!entry) throw new TimeEntryError("Apontamento não encontrado.", 404);
  if (entry.status !== "RUNNING") throw new TimeEntryError("Apontamento não está em andamento.", 409);

  return prisma.timeEntry.update({ where: { id }, data: { status: "PAUSED", pausedAt: new Date() }, include: timeEntryInclude });
}

export async function resumeTimeEntry(id: string) {
  const entry = await prisma.timeEntry.findUnique({ where: { id } });
  if (!entry) throw new TimeEntryError("Apontamento não encontrado.", 404);
  if (entry.status !== "PAUSED") throw new TimeEntryError("Apontamento não está pausado.", 409);

  const pausedMinutes = entry.pausedAt ? Math.round((Date.now() - entry.pausedAt.getTime()) / 60000) : 0;
  return prisma.timeEntry.update({
    where: { id },
    data: { status: "RUNNING", resumedAt: new Date(), pausedMinutes: entry.pausedMinutes + pausedMinutes, pausedAt: null },
    include: timeEntryInclude,
  });
}

export async function finishTimeEntry(id: string, notes?: string) {
  const entry = await prisma.timeEntry.findUnique({ where: { id } });
  if (!entry) throw new TimeEntryError("Apontamento não encontrado.", 404);
  if (entry.status === "DONE") throw new TimeEntryError("Apontamento já finalizado.", 409);

  const extraPaused = entry.status === "PAUSED" && entry.pausedAt ? Math.round((Date.now() - entry.pausedAt.getTime()) / 60000) : 0;
  return prisma.timeEntry.update({
    where: { id },
    data: { status: "DONE", endedAt: new Date(), pausedMinutes: entry.pausedMinutes + extraPaused, notes: notes ?? entry.notes },
    include: timeEntryInclude,
  });
}

function entryMinutes(entry: { startedAt: Date; endedAt: Date | null; pausedMinutes: number }) {
  const end = entry.endedAt ?? new Date();
  const totalMin = (end.getTime() - entry.startedAt.getTime()) / 60000;
  return Math.max(0, totalMin - entry.pausedMinutes);
}

// Painel "Horas disponíveis": jornada semanal (User.weeklyHours) menos horas já
// apontadas na semana corrente, por funcionário — usado para prever capacidade.
export async function getCapacityPanel() {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);

  const [employees, entries] = await Promise.all([
    prisma.user.findMany({ where: { role: { in: ["MECHANIC", "ADMIN"] } }, select: { id: true, name: true, weeklyHours: true } }),
    prisma.timeEntry.findMany({ where: { startedAt: { gte: weekStart } }, select: { employeeId: true, sector: true, startedAt: true, endedAt: true, pausedMinutes: true } }),
  ]);

  const bySector = new Map<string, { sector: string; allocatedHours: number }>();
  const byEmployee = new Map<string, { employeeId: string; name: string; weeklyHours: number; allocatedHours: number }>();

  for (const e of employees) {
    byEmployee.set(e.id, { employeeId: e.id, name: e.name, weeklyHours: e.weeklyHours ?? 0, allocatedHours: 0 });
  }
  for (const entry of entries) {
    const hours = entryMinutes(entry) / 60;
    const emp = byEmployee.get(entry.employeeId);
    if (emp) emp.allocatedHours += hours;
    const sectorKey = entry.sector ?? "Sem setor";
    const bucket = bySector.get(sectorKey) ?? { sector: sectorKey, allocatedHours: 0 };
    bucket.allocatedHours += hours;
    bySector.set(sectorKey, bucket);
  }

  return {
    byEmployee: Array.from(byEmployee.values()).map((e) => ({ ...e, freeHours: Math.max(0, e.weeklyHours - e.allocatedHours) })),
    bySector: Array.from(bySector.values()),
  };
}
