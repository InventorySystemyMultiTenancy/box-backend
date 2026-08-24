import { prisma } from "@/lib/prisma";
import { nextEstimateCode } from "@/lib/estimate-code";

export class EstimateError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface EstimateItemInput {
  approvalId?: string;
  description: string;
  classification?: string;
  quantity?: number;
  unitValue?: number;
}

export interface EstimateInput {
  serviceOrderId: string;
  insuranceCompanyId?: string;
  validUntil?: string;
  materialsTotal?: number;
  thirdPartyTotal?: number;
  discountAmount?: number;
  taxAmount?: number;
  deductibleAmount?: number;
  notes?: string;
  items?: EstimateItemInput[];
}

const estimateInclude = {
  items: { include: { approval: true }, orderBy: { createdAt: "asc" as const } },
  insuranceCompany: true,
  serviceOrder: { include: { vehicle: { include: { owner: { select: { id: true, name: true } } } } } },
};

// Soma peças/mão de obra a partir dos itens informados + o que já está aprovado na
// OS (Approval.laborValue/partsValue) — não duplica o cálculo, só agrega.
function computeTotals(items: EstimateItemInput[], extra: { materialsTotal?: number; thirdPartyTotal?: number; discountAmount?: number; taxAmount?: number; deductibleAmount?: number }) {
  const itemsTotal = items.reduce((sum, item) => sum + (item.quantity ?? 1) * (item.unitValue ?? 0), 0);
  const materialsTotal = extra.materialsTotal ?? 0;
  const thirdPartyTotal = extra.thirdPartyTotal ?? 0;
  const discountAmount = extra.discountAmount ?? 0;
  const taxAmount = extra.taxAmount ?? 0;
  const deductibleAmount = extra.deductibleAmount ?? 0;
  const totalAmount = itemsTotal + materialsTotal + thirdPartyTotal + taxAmount - discountAmount - deductibleAmount;
  return { itemsTotal, materialsTotal, thirdPartyTotal, discountAmount, taxAmount, deductibleAmount, totalAmount: Math.max(0, totalAmount) };
}

export async function listEstimates(query: Record<string, unknown>) {
  const serviceOrderId = typeof query.serviceOrderId === "string" ? query.serviceOrderId : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;
  const insuranceCompanyId = typeof query.insuranceCompanyId === "string" ? query.insuranceCompanyId : undefined;

  return prisma.estimate.findMany({
    where: {
      ...(serviceOrderId ? { serviceOrderId } : {}),
      ...(status ? { status } : {}),
      ...(insuranceCompanyId ? { insuranceCompanyId } : {}),
    },
    include: estimateInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getEstimateDetail(id: string) {
  const estimate = await prisma.estimate.findUnique({ where: { id }, include: estimateInclude });
  if (!estimate) throw new EstimateError("Orçamento não encontrado.", 404);
  return estimate;
}

export async function createEstimate(input: EstimateInput) {
  const order = await prisma.serviceOrder.findUnique({ where: { id: input.serviceOrderId } });
  if (!order) throw new EstimateError("Ordem de serviço não encontrada.", 404);

  const items = input.items ?? [];
  const totals = computeTotals(items, input);
  const code = await nextEstimateCode();

  return prisma.estimate.create({
    data: {
      code,
      serviceOrderId: input.serviceOrderId,
      insuranceCompanyId: input.insuranceCompanyId,
      validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
      laborTotal: totals.itemsTotal,
      partsTotal: 0,
      materialsTotal: totals.materialsTotal,
      thirdPartyTotal: totals.thirdPartyTotal,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      deductibleAmount: totals.deductibleAmount,
      totalAmount: totals.totalAmount,
      notes: input.notes,
      items: {
        create: items.map((item) => ({
          approvalId: item.approvalId,
          description: item.description,
          classification: item.classification ?? "PENDING",
          quantity: item.quantity ?? 1,
          unitValue: item.unitValue ?? 0,
          totalValue: (item.quantity ?? 1) * (item.unitValue ?? 0),
        })),
      },
    },
    include: estimateInclude,
  });
}

export async function updateEstimateStatus(id: string, status: string) {
  const estimate = await prisma.estimate.findUnique({ where: { id } });
  if (!estimate) throw new EstimateError("Orçamento não encontrado.", 404);
  return prisma.estimate.update({ where: { id }, data: { status }, include: estimateInclude });
}

export async function updateEstimate(id: string, input: Partial<Omit<EstimateInput, "serviceOrderId" | "items">>) {
  const estimate = await prisma.estimate.findUnique({ where: { id } });
  if (!estimate) throw new EstimateError("Orçamento não encontrado.", 404);

  const totals = computeTotals([], {
    materialsTotal: input.materialsTotal ?? estimate.materialsTotal,
    thirdPartyTotal: input.thirdPartyTotal ?? estimate.thirdPartyTotal,
    discountAmount: input.discountAmount ?? estimate.discountAmount,
    taxAmount: input.taxAmount ?? estimate.taxAmount,
    deductibleAmount: input.deductibleAmount ?? estimate.deductibleAmount,
  });

  return prisma.estimate.update({
    where: { id },
    data: {
      insuranceCompanyId: input.insuranceCompanyId,
      validUntil: input.validUntil ? new Date(input.validUntil) : undefined,
      materialsTotal: input.materialsTotal,
      thirdPartyTotal: input.thirdPartyTotal,
      discountAmount: input.discountAmount,
      taxAmount: input.taxAmount,
      deductibleAmount: input.deductibleAmount,
      notes: input.notes,
      totalAmount: estimate.laborTotal + totals.materialsTotal + totals.thirdPartyTotal + totals.taxAmount - totals.discountAmount - totals.deductibleAmount,
    },
    include: estimateInclude,
  });
}

export async function addEstimateItem(estimateId: string, input: EstimateItemInput) {
  const estimate = await prisma.estimate.findUnique({ where: { id: estimateId }, include: { items: true } });
  if (!estimate) throw new EstimateError("Orçamento não encontrado.", 404);

  const totalValue = (input.quantity ?? 1) * (input.unitValue ?? 0);
  return prisma.$transaction(async (tx) => {
    await tx.estimateItem.create({
      data: {
        estimateId,
        approvalId: input.approvalId,
        description: input.description,
        classification: input.classification ?? "PENDING",
        quantity: input.quantity ?? 1,
        unitValue: input.unitValue ?? 0,
        totalValue,
      },
    });
    return tx.estimate.update({
      where: { id: estimateId },
      data: { laborTotal: estimate.laborTotal + totalValue, totalAmount: estimate.totalAmount + totalValue },
      include: estimateInclude,
    });
  });
}

export async function removeEstimateItem(estimateId: string, itemId: string) {
  const item = await prisma.estimateItem.findUnique({ where: { id: itemId } });
  if (!item || item.estimateId !== estimateId) throw new EstimateError("Item não encontrado neste orçamento.", 404);

  const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
  return prisma.$transaction(async (tx) => {
    await tx.estimateItem.delete({ where: { id: itemId } });
    return tx.estimate.update({
      where: { id: estimateId },
      data: { laborTotal: estimate.laborTotal - item.totalValue, totalAmount: estimate.totalAmount - item.totalValue },
      include: estimateInclude,
    });
  });
}
