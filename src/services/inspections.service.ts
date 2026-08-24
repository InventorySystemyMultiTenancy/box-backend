import { prisma } from "@/lib/prisma";

export class InspectionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface InspectionInput {
  serviceOrderId: string;
  insuranceCompanyId?: string;
  inspectorId?: string;
  scheduledAt?: string;
  location?: string;
  type?: string;
  notes?: string;
}

const inspectionInclude = {
  serviceOrder: { include: { vehicle: { include: { owner: { select: { id: true, name: true } } } } } },
  insuranceCompany: true,
  inspector: { select: { id: true, name: true } },
  issues: { orderBy: { createdAt: "asc" as const }, include: { responsible: { select: { id: true, name: true } } } },
  media: true,
};

export async function listInspections(query: Record<string, unknown>) {
  const status = typeof query.status === "string" ? query.status : undefined;
  const insuranceCompanyId = typeof query.insuranceCompanyId === "string" ? query.insuranceCompanyId : undefined;
  const inspectorId = typeof query.inspectorId === "string" ? query.inspectorId : undefined;
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;

  return prisma.inspection.findMany({
    where: {
      ...(status ? { status } : {}),
      ...(insuranceCompanyId ? { insuranceCompanyId } : {}),
      ...(inspectorId ? { inspectorId } : {}),
      ...(from || to ? { scheduledAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    },
    include: inspectionInclude,
    orderBy: { scheduledAt: "asc" },
  });
}

// Fila "a marcar": OS ativas (não entregues/canceladas) sem nenhuma Inspection ainda —
// calculado, não é um status manual, para não depender de alguém lembrar de marcar.
export async function listInspectionsToSchedule() {
  const orders = await prisma.serviceOrder.findMany({
    where: {
      status: { notIn: ["READY_FOR_PICKUP"] },
      inspections: { none: {} },
    },
    include: { vehicle: { include: { owner: { select: { id: true, name: true } } } }, insuranceCompany: true },
    orderBy: { createdAt: "asc" },
  });
  return orders;
}

export async function getInspectionDetail(id: string) {
  const inspection = await prisma.inspection.findUnique({ where: { id }, include: inspectionInclude });
  if (!inspection) throw new InspectionError("Vistoria não encontrada.", 404);
  return inspection;
}

export async function createInspection(input: InspectionInput) {
  const order = await prisma.serviceOrder.findUnique({ where: { id: input.serviceOrderId } });
  if (!order) throw new InspectionError("Ordem de serviço não encontrada.", 404);

  return prisma.inspection.create({
    data: {
      serviceOrderId: input.serviceOrderId,
      insuranceCompanyId: input.insuranceCompanyId,
      inspectorId: input.inspectorId,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
      location: input.location,
      type: input.type,
      notes: input.notes,
      status: input.scheduledAt ? "SCHEDULED" : "TO_SCHEDULE",
    },
    include: inspectionInclude,
  });
}

export async function updateInspection(id: string, input: Partial<InspectionInput> & { status?: string; result?: string }) {
  const inspection = await prisma.inspection.findUnique({ where: { id } });
  if (!inspection) throw new InspectionError("Vistoria não encontrada.", 404);

  return prisma.inspection.update({
    where: { id },
    data: {
      insuranceCompanyId: input.insuranceCompanyId,
      inspectorId: input.inspectorId,
      scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
      location: input.location,
      type: input.type,
      notes: input.notes,
      status: input.status,
      result: input.result,
    },
    include: inspectionInclude,
  });
}

export async function createInspectionIssue(
  inspectionId: string,
  input: { item: string; description?: string; responsibleId?: string; dueDate?: string }
) {
  const inspection = await prisma.inspection.findUnique({ where: { id: inspectionId } });
  if (!inspection) throw new InspectionError("Vistoria não encontrada.", 404);

  return prisma.$transaction(async (tx) => {
    await tx.inspectionIssue.create({
      data: {
        inspectionId,
        item: input.item,
        description: input.description,
        responsibleId: input.responsibleId,
        dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      },
    });
    return tx.inspection.update({
      where: { id: inspectionId },
      data: { status: "ADJUSTMENT_PENDING" },
      include: inspectionInclude,
    });
  });
}

export async function updateInspectionIssue(inspectionId: string, issueId: string, input: { status?: string; description?: string; responsibleId?: string; dueDate?: string }) {
  const issue = await prisma.inspectionIssue.findUnique({ where: { id: issueId } });
  if (!issue || issue.inspectionId !== inspectionId) throw new InspectionError("Ajuste não encontrado nesta vistoria.", 404);

  return prisma.inspectionIssue.update({
    where: { id: issueId },
    data: {
      status: input.status,
      description: input.description,
      responsibleId: input.responsibleId,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    },
    include: { responsible: { select: { id: true, name: true } } },
  });
}

// "Regularização de orçamentos" — sinaliza OS com pendências antes de fechar o
// processo: complemento pendente, aprovação pendente ou vistoria com ajuste em aberto.
export async function listIrregularEstimates() {
  const [pendingSupplements, pendingApprovals, adjustmentPending] = await Promise.all([
    prisma.approval.findMany({
      where: { kind: "SUPPLEMENT", status: "PENDING" },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.approval.findMany({
      where: { kind: "INITIAL", status: "PENDING" },
      include: { serviceOrder: { include: { vehicle: true } } },
    }),
    prisma.inspection.findMany({
      where: { status: "ADJUSTMENT_PENDING" },
      include: { serviceOrder: { include: { vehicle: true } }, issues: { where: { status: { not: "RESOLVED" } } } },
    }),
  ]);

  const byOrder = new Map<string, { serviceOrder: any; reasons: string[] }>();
  function add(order: any, reason: string) {
    const bucket = byOrder.get(order.id) ?? { serviceOrder: order, reasons: [] };
    bucket.reasons.push(reason);
    byOrder.set(order.id, bucket);
  }
  for (const a of pendingSupplements) add(a.serviceOrder, "Complemento de mão de obra pendente");
  for (const a of pendingApprovals) add(a.serviceOrder, "Aprovação de orçamento pendente");
  for (const i of adjustmentPending) add(i.serviceOrder, `Vistoria com ${i.issues.length} ajuste(s) em aberto`);

  return Array.from(byOrder.values());
}
