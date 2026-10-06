import { randomUUID } from "crypto";
import { prisma, AppTx } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { roundMoney, splitInstallments } from "@/services/finance-rules";
import { normalizeClassification, rememberExpenseClassification } from "@/services/expense-classifications.service";

export class PayableError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Uma duplicata/boleto digitada na tabela "Condições de pagamento". */
export interface PayableDuplicateInput {
  dueDate: string;
  amount: number;
  paymentMethod?: string; // Tipo Docto (Boleto, PIX...)
  documentNumber?: string; // Dupl./nº do documento
  // Já paga: preencher só se o pagamento foi efetuado (baixa na hora).
  paidAt?: string;
  bankAccountId?: string;
}

export interface AccountPayableInput {
  description?: string;
  category: string; // categoria / natureza da operação
  payeeName: string;
  supplierId?: string;
  notes?: string;
  paymentMethod?: string;
  bankAccountId?: string; // "Pagto previsto na C/C"
  // Classificação e documento (formulário "Cadastrar contas a pagar").
  expenseGroup?: string;
  expenseDescription?: string;
  expenseSector?: string;
  invoiceNumber?: string;
  issueDate?: string;
  storeId?: string;
  createdById?: string;
  // Ou parcelamento automático (valor dividido em N meses a partir de dueDate)...
  amount?: number;
  dueDate?: string;
  installments?: number;
  // ...ou as duplicatas digitadas uma a uma (vencimento/valor de cada).
  duplicates?: PayableDuplicateInput[];
  // Preenchido quando as parcelas nascem de uma nota fiscal de despesa (ver
  // invoices.service.ts) — liga cada AccountPayable de volta à Invoice de origem.
  invoiceId?: string;
}

export interface PayInput {
  paidAt?: string;
  paidAmount?: number;
  bankAccountId?: string;
  paymentMethod?: string;
}

export interface UpdatePayableInput {
  description?: string;
  category?: string;
  payeeName?: string;
  amount?: number;
  dueDate?: string;
  paymentMethod?: string;
  bankAccountId?: string;
  notes?: string;
  paidAt?: string;
  paidAmount?: number;
  expenseGroup?: string;
  expenseDescription?: string;
  expenseSector?: string;
  invoiceNumber?: string;
  documentNumber?: string;
}

/** Texto mostrado na lista quando não se informa descrição: "ASSISTÊNCIA MÉDICA — AMIL SAÚDE". */
export function payableDisplayDescription(input: Pick<AccountPayableInput, "description" | "expenseDescription" | "expenseGroup" | "category" | "payeeName" | "invoiceNumber">) {
  if (input.description?.trim()) return input.description.trim();
  const what = input.expenseDescription || input.expenseGroup || input.category;
  return [what, input.payeeName, input.invoiceNumber ? `NF ${input.invoiceNumber}` : null].filter(Boolean).join(" — ");
}

// Cada duplicata vira um registro; mais de uma compartilham groupId e têm
// installmentNumber/Total — cada uma é baixada individualmente. Sem duplicatas digitadas,
// divide `amount` em `installments` meses a partir de `dueDate` (comportamento antigo).
// As classificações usadas ficam salvas para as próximas contas.
export async function createAccountsPayable(input: AccountPayableInput, tx?: AppTx) {
  const classification = normalizeClassification({
    category: input.category,
    group: input.expenseGroup,
    description: input.expenseDescription,
    sector: input.expenseSector,
  });
  const category = classification.category ?? "OUTROS";

  const duplicates: PayableDuplicateInput[] =
    input.duplicates && input.duplicates.length > 0
      ? input.duplicates
      : input.amount !== undefined && input.dueDate
        ? splitInstallments(input.amount, input.installments ?? 1, new Date(input.dueDate)).map((p) => ({
            dueDate: p.dueDate.toISOString(),
            amount: p.amount,
          }))
        : [];
  if (duplicates.length === 0) throw new PayableError("Informe ao menos uma duplicata (vencimento e valor).", 400);

  const total = duplicates.length;
  const groupId = total > 1 ? randomUUID() : undefined;
  const description = payableDisplayDescription({
    ...input,
    category,
    expenseGroup: classification.group,
    expenseDescription: classification.description,
  });

  const rows = duplicates.map((dup, i) => {
    const paid = Boolean(dup.paidAt);
    return {
      description,
      category,
      payeeName: input.payeeName.trim(),
      supplierId: input.supplierId,
      amount: roundMoney(dup.amount),
      dueDate: new Date(dup.dueDate),
      paymentMethod: dup.paymentMethod || input.paymentMethod,
      bankAccountId: dup.bankAccountId || input.bankAccountId,
      notes: input.notes,
      expenseGroup: classification.group,
      expenseDescription: classification.description,
      expenseSector: classification.sector,
      invoiceNumber: input.invoiceNumber?.trim() || undefined,
      issueDate: input.issueDate ? new Date(input.issueDate) : undefined,
      documentNumber: dup.documentNumber?.trim() || undefined,
      storeId: input.storeId,
      createdById: input.createdById,
      installmentNumber: total > 1 ? i + 1 : undefined,
      installmentTotal: total > 1 ? total : undefined,
      groupId,
      invoiceId: input.invoiceId,
      ...(paid ? { status: "PAID", paidAt: new Date(dup.paidAt!), paidAmount: roundMoney(dup.amount) } : {}),
    };
  });

  const run = async (db: AppTx) => {
    await rememberExpenseClassification(db, { ...classification, category });
    // Devolve exatamente as linhas criadas (buscar por descrição depois podia trazer outra igual).
    return db.accountPayable.createManyAndReturn({ data: rows });
  };
  return tx ? run(tx) : prisma.$transaction((t) => run(t));
}

export async function listAccountsPayable(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = typeof query.status === "string" ? query.status : undefined;
  const category = typeof query.category === "string" ? query.category : undefined;
  const from = typeof query.from === "string" ? new Date(query.from) : undefined;
  const to = typeof query.to === "string" ? new Date(query.to) : undefined;
  // "Nome" = fornecedor/beneficiário (payeeName); "número de nota" busca pela nota
  // fiscal ligada (Invoice.number) — nem toda conta a pagar tem uma nota vinculada.
  const payeeName = typeof query.payeeName === "string" && query.payeeName.trim() ? query.payeeName.trim() : undefined;
  const invoiceNumber = typeof query.invoiceNumber === "string" && query.invoiceNumber.trim() ? query.invoiceNumber.trim() : undefined;
  // Despesas separadas por setor (origem) e por grupo.
  const sector = typeof query.sector === "string" && query.sector.trim() ? query.sector.trim() : undefined;
  const group = typeof query.group === "string" && query.group.trim() ? query.group.trim() : undefined;

  await markOverduePayables();

  const where = {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
    ...(sector ? { expenseSector: sector } : {}),
    ...(group ? { expenseGroup: group } : {}),
    ...(from || to ? { dueDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    ...(payeeName ? { payeeName: { contains: payeeName, mode: "insensitive" as const } } : {}),
    // Nº da nota digitado na própria conta ou o da nota fiscal ligada.
    ...(invoiceNumber
      ? {
          OR: [
            { invoiceNumber: { contains: invoiceNumber, mode: "insensitive" as const } },
            { invoice: { number: { contains: invoiceNumber, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.accountPayable.findMany({
      where,
      include: {
        bankAccount: true,
        invoice: { select: { id: true, number: true } },
        createdBy: { select: { id: true, name: true } },
        store: { select: { id: true, name: true } },
      },
      orderBy: { dueDate: "asc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.accountPayable.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

export async function payAccountPayable(id: string, input: PayInput) {
  const payable = await prisma.accountPayable.findUnique({ where: { id } });
  if (!payable) throw new PayableError("Conta a pagar não encontrada.", 404);
  if (payable.status === "PAID") throw new PayableError("Esta conta já está paga.", 409);

  return prisma.accountPayable.update({
    where: { id },
    data: {
      status: "PAID",
      paidAt: input.paidAt ? new Date(input.paidAt) : new Date(),
      paidAmount: input.paidAmount ?? payable.amount,
      bankAccountId: input.bankAccountId ?? payable.bankAccountId,
      paymentMethod: input.paymentMethod ?? payable.paymentMethod,
    },
  });
}

// Edição livre de qualquer campo pelo usuário — inclusive de uma conta já paga
// (corrigir valor/data lançados errado), diferente de "pagar" (que só baixa o status).
export async function updateAccountPayable(id: string, input: UpdatePayableInput) {
  const existing = await prisma.accountPayable.findUnique({ where: { id } });
  if (!existing) throw new PayableError("Conta a pagar não encontrada.", 404);

  const c = normalizeClassification({
    category: input.category,
    group: input.expenseGroup,
    description: input.expenseDescription,
    sector: input.expenseSector,
  });
  await rememberExpenseClassification(prisma, { ...c, group: c.group ?? existing.expenseGroup });

  return prisma.accountPayable.update({
    where: { id },
    data: {
      description: input.description,
      category: c.category,
      expenseGroup: c.group,
      expenseDescription: c.description,
      expenseSector: c.sector,
      invoiceNumber: input.invoiceNumber,
      documentNumber: input.documentNumber,
      payeeName: input.payeeName,
      amount: input.amount,
      dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
      paymentMethod: input.paymentMethod,
      bankAccountId: input.bankAccountId,
      notes: input.notes,
      paidAt: input.paidAt ? new Date(input.paidAt) : undefined,
      paidAmount: input.paidAmount,
    },
  });
}

export async function cancelAccountPayable(id: string) {
  const payable = await prisma.accountPayable.findUnique({ where: { id } });
  if (!payable) throw new PayableError("Conta a pagar não encontrada.", 404);
  return prisma.accountPayable.update({ where: { id }, data: { status: "CANCELLED" } });
}

async function markOverduePayables() {
  await prisma.accountPayable.updateMany({
    where: { status: "PENDING", dueDate: { lt: new Date() } },
    data: { status: "OVERDUE" },
  });
}
