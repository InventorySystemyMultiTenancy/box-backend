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
  approval: { select: { id: true, title: true, estimatedValue: true, laborValue: true } },
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
        basisType: "APPROVAL_ESTIMATE",
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

export interface ManualCommissionInput {
  mechanicId: string;
  serviceOrderId: string;
  rate: number;
  basisType: "APPROVAL_LABOR" | "ORDER_TOTAL";
  // Obrigatório quando basisType é APPROVAL_LABOR — qual reparo do projeto usar
  // como base (a mão de obra daquele reparo específico).
  approvalId?: string;
}

// Criação manual — admin escolhe funcionário, projeto, % e a base do cálculo:
// mão de obra de um reparo específico ou o valor final do projeto (soma dos
// aprovados). Diferente do gerador automático, aqui o rate é livre, não vem de
// User.commissionRate.
export async function createManualCommission(input: ManualCommissionInput) {
  if (input.rate <= 0) throw new CommissionError("Informe uma porcentagem válida.", 400);

  const mechanic = await prisma.user.findUnique({ where: { id: input.mechanicId } });
  if (!mechanic) throw new CommissionError("Funcionário não encontrado.", 404);

  const order = await prisma.serviceOrder.findUnique({
    where: { id: input.serviceOrderId },
    include: { approvals: true },
  });
  if (!order) throw new CommissionError("Projeto não encontrado.", 404);

  let baseAmount: number;
  let approvalId: string | undefined;

  if (input.basisType === "APPROVAL_LABOR") {
    if (!input.approvalId) throw new CommissionError("Selecione o reparo que servirá de base.", 400);
    const approval = order.approvals.find((a) => a.id === input.approvalId);
    if (!approval) throw new CommissionError("Reparo não encontrado neste projeto.", 404);
    if (!approval.laborValue) throw new CommissionError("Este reparo ainda não tem mão de obra definida.", 400);

    const existing = await prisma.commission.findUnique({ where: { approvalId: approval.id } });
    if (existing) throw new CommissionError("Já existe uma comissão lançada para este reparo.", 409);

    baseAmount = approval.laborValue;
    approvalId = approval.id;
  } else {
    baseAmount = order.approvals.filter((a) => a.status === "APPROVED").reduce((sum, a) => sum + (a.estimatedValue ?? 0), 0);
    if (baseAmount <= 0) throw new CommissionError("Este projeto ainda não tem valor aprovado para basear a comissão.", 400);
  }

  const amount = baseAmount * input.rate;

  return prisma.commission.create({
    data: {
      mechanicId: mechanic.id,
      approvalId,
      serviceOrderId: order.id,
      basisType: input.basisType,
      baseAmount,
      rate: input.rate,
      amount,
    },
    include,
  });
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
