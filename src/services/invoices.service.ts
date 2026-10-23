import { prisma } from "@/lib/prisma";
import { parsePageParams, paginated } from "@/lib/pagination";
import { NFeProvider } from "@/services/fiscal/nfe-provider";
import { MockNFeProvider } from "@/services/fiscal/mock-provider";
import { createAccountsPayable } from "@/services/accounts-payable.service";
import { normalizeClassification, rememberExpenseClassification } from "@/services/expense-classifications.service";

export class InvoiceError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface InvoiceInput {
  type?: "NFE" | "NFSE" | "NFCE";
  totalAmount: number;
  description?: string;
  // Nota de despesa (conta a pagar): gera as parcelas já classificadas.
  isExpense?: boolean;
  expenseGroup?: string;
  expenseDescription?: string;
  expenseSector?: string;
  bankAccountId?: string;
  createdById?: string;
  serviceOrderId?: string;
  clientId?: string;
  accountReceivableId?: string;
  // Preenchidos quando a nota já existe fisicamente (digitada à mão ou lida por IA a
  // partir de uma foto) — nesse caso a nota nasce ISSUED, não DRAFT.
  number?: string;
  series?: string;
  accessKey?: string;
  operationNature?: string;
  issuerName?: string;
  issuerDocument?: string;
  recipientName?: string;
  recipientDocument?: string;
  paymentMethod?: string;
  discountAmount?: number;
  taxAmount?: number;
  issueDate?: string;
  // Só usados quando é nota de despesa ou paga por boleto — geram N contas a pagar a
  // partir de dueDate, a cada installmentIntervalDays dias (ou mês a mês, se não vier).
  installments?: number;
  installmentIntervalDays?: number;
  dueDate?: string;
  // Parcelas já montadas no formulário (vencimento/valor de cada uma) — têm prioridade.
  duplicates?: { dueDate: string; amount: number; documentNumber?: string }[];
}

const sameText = (value?: string | null) => (value?.trim() ? { equals: value.trim(), mode: "insensitive" as const } : undefined);

/**
 * Nota já cadastrada (não cancelada)? Com número: mesmo número e mesmo emitente (CNPJ/CPF,
 * ou nome se não houver documento) — fornecedores diferentes podem repetir numeração; se
 * a nota não tem emitente informado, basta o número. Sem número: mesmo emitente, mesmo valor
 * e mesma data de emissão.
 */
export async function findDuplicateInvoice(input: Pick<InvoiceInput, "number" | "issuerName" | "issuerDocument" | "totalAmount" | "issueDate">) {
  const number = input.number?.trim();
  const doc = input.issuerDocument?.replace(/\D/g, "") || undefined;
  // CNPJ/CPF pode ter sido gravado com ou sem pontuação.
  const issuer = doc
    ? { OR: [{ issuerDocument: doc }, { issuerDocument: input.issuerDocument!.trim() }] }
    : input.issuerName?.trim()
      ? { issuerName: sameText(input.issuerName) }
      : null;

  if (number) {
    return prisma.invoice.findFirst({
      where: { status: { not: "CANCELLED" }, number: sameText(number), ...(issuer ?? {}) },
      select: { id: true, number: true, issuerName: true, totalAmount: true, createdAt: true },
    });
  }
  if (!issuer || !input.issueDate) return null;
  const day = input.issueDate.slice(0, 10);
  const start = new Date(`${day}T00:00:00.000Z`);
  return prisma.invoice.findFirst({
    where: {
      status: { not: "CANCELLED" },
      ...issuer,
      totalAmount: input.totalAmount,
      issueDate: { gte: start, lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) },
    },
    select: { id: true, number: true, issuerName: true, totalAmount: true, createdAt: true },
  });
}

function isBoleto(paymentMethod?: string) {
  return Boolean(paymentMethod?.trim().toLowerCase().includes("boleto"));
}

// Ponto único de troca do gateway fiscal — plugar um provider real aqui quando a
// oficina tiver certificado digital e contrato com um gateway (eNotas, Focus NFe...).
const provider: NFeProvider = new MockNFeProvider();

function str(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function listInvoices(query: Record<string, unknown>) {
  const pageParams = parsePageParams(query);
  const status = str(query.status);
  const type = str(query.type);
  const clientName = str(query.clientName);
  const number = str(query.number);
  const orderCode = str(query.orderCode);
  const date = str(query.date);
  // Só notas que ainda podem ser ligadas a um recebimento: sem conta a receber, sem contas
  // a pagar (nota de despesa) e não canceladas — lista do "Associar nota existente".
  const unlinked = query.unlinked === "true";

  // Cada filtro entra como uma condição própria (em vez de espalhar chaves no mesmo
  // objeto) pra não colidir quando mais de um filtro precisa do seu próprio OR
  // (nome do cliente e data, por exemplo).
  const conditions: Record<string, unknown>[] = [];
  if (status) conditions.push({ status });
  if (unlinked) conditions.push({ accountReceivableId: null, payables: { none: {} }, status: { not: "CANCELLED" } });
  if (type) conditions.push({ type });
  if (clientName) {
    conditions.push({
      OR: [
        { client: { name: { contains: clientName, mode: "insensitive" } } },
        { recipientName: { contains: clientName, mode: "insensitive" } },
        // Notas de despesa (contas a pagar) — o nome buscado é o do fornecedor/emitente.
        { issuerName: { contains: clientName, mode: "insensitive" } },
      ],
    });
  }
  if (number) conditions.push({ number: { contains: number, mode: "insensitive" } });
  if (orderCode) conditions.push({ serviceOrder: { code: { contains: orderCode, mode: "insensitive" } } });
  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    // Nota emitida sem data (rascunho) ainda entra na busca pela data de cadastro.
    conditions.push({
      OR: [
        { issueDate: { gte: start, lt: end } },
        { issueDate: null, createdAt: { gte: start, lt: end } },
      ],
    });
  }

  const where = conditions.length > 0 ? { AND: conditions } : {};

  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        client: true,
        serviceOrder: { select: { id: true, code: true } },
        payables: { orderBy: { dueDate: "asc" } },
      },
      orderBy: { createdAt: "desc" },
      skip: pageParams.skip,
      take: pageParams.take,
    }),
    prisma.invoice.count({ where }),
  ]);

  return paginated(items, total, pageParams);
}

// Se `number` vier preenchido, a nota já existe fisicamente (digitada ou lida de uma
// foto) — nasce ISSUED. Caso contrário, nasce DRAFT para ser emitida depois via /issue.
// Nota de despesa (isExpense) ou paga por boleto também gera as parcelas como contas a
// pagar (a cada N dias ou mês a mês, a partir de dueDate), ligadas a esta nota e com a mesma
// classificação (categoria = natureza da operação, grupo, descrição, setor) e banco.
export async function createInvoiceDraft(input: InvoiceInput) {
  const generatesPayables = Boolean(input.isExpense) || isBoleto(input.paymentMethod);
  const duplicates = input.duplicates?.length ? input.duplicates : undefined;
  if (generatesPayables && !input.dueDate && !duplicates) {
    throw new InvoiceError('Informe o vencimento e clique em "Gerar parcelas".', 400);
  }
  if (generatesPayables && duplicates) {
    const sum = duplicates.reduce((total, d) => total + d.amount, 0);
    if (Math.abs(sum - input.totalAmount) >= 0.01) {
      throw new InvoiceError("A soma das parcelas não bate com o valor total da nota — gere as parcelas de novo.", 400);
    }
  }

  // Não deixa cadastrar a mesma nota duas vezes.
  const duplicate = await findDuplicateInvoice(input);
  if (duplicate) {
    const what = [duplicate.number ? `NF ${duplicate.number}` : null, duplicate.issuerName].filter(Boolean).join(" — ");
    throw new InvoiceError(
      `Esta nota fiscal já foi cadastrada${what ? ` (${what}, cadastrada em ${duplicate.createdAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })})` : ""}.`,
      409
    );
  }
  const classification = normalizeClassification({
    category: input.operationNature,
    group: input.expenseGroup,
    description: input.expenseDescription,
    sector: input.expenseSector,
  });

  const isExisting = Boolean(input.number);
  const invoiceId = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        type: input.type ?? "NFE",
        status: isExisting ? "ISSUED" : "DRAFT",
        totalAmount: input.totalAmount,
        description: input.description?.trim() || undefined,
        expenseGroup: classification.group,
        expenseDescription: classification.description,
        expenseSector: classification.sector,
        bankAccountId: input.bankAccountId || undefined,
        serviceOrderId: input.serviceOrderId,
        clientId: input.clientId,
        accountReceivableId: input.accountReceivableId,
        number: input.number,
        series: input.series,
        accessKey: input.accessKey,
        operationNature: classification.category,
        issuerName: input.issuerName,
        issuerDocument: input.issuerDocument,
        recipientName: input.recipientName,
        recipientDocument: input.recipientDocument,
        paymentMethod: input.paymentMethod,
        discountAmount: input.discountAmount,
        taxAmount: input.taxAmount,
        issueDate: isExisting ? new Date(input.issueDate ?? Date.now()) : undefined,
        provider: isExisting ? "MANUAL" : provider.name,
      },
    });

    if (generatesPayables && (duplicates || input.dueDate)) {
      await createAccountsPayable(
        {
          description: input.description?.trim() || undefined,
          category: classification.category ?? "FORNECEDOR",
          expenseGroup: classification.group,
          expenseDescription: classification.description,
          expenseSector: classification.sector,
          payeeName: input.issuerName?.trim() || "Fornecedor",
          amount: input.totalAmount,
          dueDate: input.dueDate,
          duplicates: duplicates?.map((d) => ({ dueDate: d.dueDate, amount: d.amount, documentNumber: d.documentNumber })),
          paymentMethod: input.paymentMethod,
          bankAccountId: input.bankAccountId || undefined,
          installments: input.installments,
          installmentIntervalDays: input.installmentIntervalDays,
          invoiceNumber: input.number,
          issueDate: input.issueDate,
          createdById: input.createdById,
          invoiceId: invoice.id,
        },
        tx
      );
    } else {
      await rememberExpenseClassification(tx, classification);
    }
    return invoice.id;
  });

  return prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payables: { orderBy: { dueDate: "asc" } } } });
}

export async function issueInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { client: true } });
  if (!invoice) throw new InvoiceError("Nota fiscal não encontrada.", 404);
  if (invoice.status === "ISSUED") throw new InvoiceError("Esta nota já foi emitida.", 409);
  if (invoice.status === "CANCELLED") throw new InvoiceError("Esta nota foi cancelada.", 409);

  try {
    const result = await provider.issue({
      type: invoice.type as "NFE" | "NFSE" | "NFCE",
      totalAmount: invoice.totalAmount,
      clientName: invoice.client?.name,
      description: `Emissão referente à OS/cobrança ${invoice.id}`,
    });

    return prisma.invoice.update({
      where: { id },
      data: {
        status: "ISSUED",
        number: result.number,
        series: result.series,
        providerRef: result.providerRef,
        xmlUrl: result.xmlUrl,
        pdfUrl: result.pdfUrl,
        issueDate: new Date(),
        errorMessage: null,
      },
    });
  } catch (err) {
    await prisma.invoice.update({
      where: { id },
      data: { status: "ERROR", errorMessage: err instanceof Error ? err.message : "Falha ao emitir." },
    });
    throw new InvoiceError("Falha ao emitir a nota fiscal.", 502);
  }
}

export async function cancelInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice) throw new InvoiceError("Nota fiscal não encontrada.", 404);
  if (invoice.status !== "ISSUED") throw new InvoiceError("Só é possível cancelar uma nota emitida.", 409);

  if (invoice.providerRef) await provider.cancel(invoice.providerRef);

  return prisma.invoice.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}
