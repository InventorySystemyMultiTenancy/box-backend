import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";

export class CommissionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const include = {
  mechanic: { select: { id: true, name: true, commissionRate: true } },
  serviceOrder: { select: { id: true, code: true } },
  approval: { select: { id: true, title: true, estimatedValue: true } },
} as const;

// Gera comissões a partir de aprovações já respondidas (APPROVED) no período, atribuídas
// ao mecânico responsável pelo componente (VehiclePart.responsibleId). Idempotente: o
// @unique em Commission.approvalId garante que rodar de novo sobre o mesmo período não duplica.
export async function generateCommissions(from: string, to: string) {
  const approvals = await prisma.approval.findMany({
    where: {
      status: "APPROVED",
      respondedAt: { gte: new Date(from), lte: new Date(to) },
      commission: null,
      part: { responsibleId: { not: null } },
    },
    include: { part: { include: { responsible: true } } },
  });

  const created = [];
  for (const approval of approvals) {
    const mechanic = approval.part?.responsible;
    if (!mechanic || !mechanic.commissionRate || !approval.estimatedValue) continue;

    const rate = mechanic.commissionRate;
    const baseAmount = approval.estimatedValue;
    const amount = baseAmount * rate;

    const commission = await prisma.commission.create({
      data: {
        mechanicId: mechanic.id,
        approvalId: approval.id,
        serviceOrderId: approval.serviceOrderId,
        baseAmount,
        rate,
        amount,
      },
      include,
    });
    created.push(commission);
  }

  return created;
}

export async function listCommissions(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const mechanicId = typeof query.mechanicId === "string" ? query.mechanicId : undefined;
  const status = typeof query.status === "string" ? query.status : undefined;

  const where = { ...(mechanicId ? { mechanicId } : {}), ...(status ? { status } : {}) };

  const [items, total] = await Promise.all([
    prisma.commission.findMany({ where, include, orderBy: { createdAt: "desc" }, skip: pageParams.skip, take: pageParams.take }),
    prisma.commission.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

// Paga uma comissão: gera uma AccountPayable (categoria COMISSAO) vinculada, como
// acontece com pedidos de compra enviados a fornecedor.
export async function payCommission(id: string, bankAccountId?: string) {
  const commission = await prisma.commission.findUnique({ where: { id }, include: { mechanic: true } });
  if (!commission) throw new CommissionError("Comissão não encontrada.", 404);
  if (commission.status !== "PENDING") throw new CommissionError("Esta comissão não está pendente.", 409);

  return prisma.$transaction(async (tx) => {
    const payable = await tx.accountPayable.create({
      data: {
        description: `Comissão — ${commission.mechanic.name}`,
        category: "COMISSAO",
        payeeName: commission.mechanic.name,
        amount: commission.amount,
        dueDate: new Date(),
        status: "PAID",
        paidAt: new Date(),
        paidAmount: commission.amount,
        bankAccountId,
      },
    });
    return tx.commission.update({
      where: { id },
      data: { status: "PAID", paidAt: new Date(), accountPayableId: payable.id },
      include,
    });
  });
}

export async function cancelCommission(id: string) {
  const commission = await prisma.commission.findUnique({ where: { id } });
  if (!commission) throw new CommissionError("Comissão não encontrada.", 404);
  if (commission.status === "PAID") throw new CommissionError("Não é possível cancelar uma comissão já paga.", 409);
  return prisma.commission.update({ where: { id }, data: { status: "CANCELLED" } });
}
