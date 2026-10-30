import { prisma, AppTx } from "@/lib/prisma";
import { HttpError } from "@/lib/http-error";

// Cadastro das classificações de despesa (categoria/natureza, grupo, descrição e setor). O
// que é digitado ao lançar uma conta a pagar ou nota de despesa fica salvo aqui e volta
// como sugestão nos próximos lançamentos. Grupos e as categorias de cada grupo também são
// editados em Contas a pagar > "Grupos e categorias".

export interface ExpenseClassificationInput {
  category?: string | null;
  group?: string | null;
  description?: string | null;
  sector?: string | null;
}

type Db = Pick<AppTx, "expenseClassification">;

function clean(value?: string | null) {
  const v = value?.trim().replace(/\s+/g, " ");
  return v ? v : undefined;
}

/** Normaliza os textos (espaços extras) — usado também antes de gravar na conta/nota. */
export function normalizeClassification(input: ExpenseClassificationInput) {
  return {
    category: clean(input.category),
    group: clean(input.group),
    description: clean(input.description),
    sector: clean(input.sector),
  };
}

export async function rememberExpenseClassification(db: Db, input: ExpenseClassificationInput) {
  const c = normalizeClassification(input);
  const rows: { kind: string; name: string; parentName: string }[] = [];
  if (c.category) rows.push({ kind: "CATEGORY", name: c.category, parentName: "" });
  // Categoria também fica guardada dentro do grupo — volta como sugestão daquele grupo.
  if (c.category && c.group) rows.push({ kind: "CATEGORY", name: c.category, parentName: c.group });
  if (c.group) rows.push({ kind: "GROUP", name: c.group, parentName: "" });
  if (c.description) rows.push({ kind: "DESCRIPTION", name: c.description, parentName: c.group ?? "" });
  if (c.sector) rows.push({ kind: "SECTOR", name: c.sector, parentName: "" });
  if (rows.length > 0) await db.expenseClassification.createMany({ data: rows, skipDuplicates: true });
}

export async function listExpenseClassifications() {
  const rows = await prisma.expenseClassification.findMany({ orderBy: { name: "asc" } });
  const names = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.name);
  return {
    categories: [...new Set(names("CATEGORY"))],
    groups: names("GROUP"),
    sectors: names("SECTOR"),
    // Descrição pertence a um grupo (ASSISTÊNCIA MÉDICA → FOLHA DE PAGAMENTO); "" = sem grupo.
    descriptions: rows.filter((r) => r.kind === "DESCRIPTION").map((r) => ({ group: r.parentName, name: r.name })),
    // Categorias de cada grupo (plano de contas: DESPESAS FIXAS → ALUGUEL PREDIAL, SABESP...).
    groupCategories: rows.filter((r) => r.kind === "CATEGORY" && r.parentName).map((r) => ({ group: r.parentName, name: r.name })),
  };
}

function requiredName(value: string) {
  const name = clean(value);
  if (!name) throw new HttpError(400, "Informe o nome.");
  return name;
}

async function groupExists(name: string) {
  return prisma.expenseClassification.findUnique({ where: { kind_parentName_name: { kind: "GROUP", parentName: "", name } } });
}

export async function createExpenseGroup(rawName: string) {
  const name = requiredName(rawName);
  if (await groupExists(name)) throw new HttpError(409, `O grupo ${name} já existe.`);
  await prisma.expenseClassification.create({ data: { kind: "GROUP", name, parentName: "" } });
}

/** Renomeia o grupo, as categorias/descrições dele e as contas e notas já lançadas com ele. */
export async function renameExpenseGroup(rawOldName: string, rawName: string) {
  const oldName = requiredName(rawOldName);
  const name = requiredName(rawName);
  if (oldName === name) return;
  if (!(await groupExists(oldName))) throw new HttpError(404, "Grupo não encontrado.");
  if (await groupExists(name)) throw new HttpError(409, `O grupo ${name} já existe.`);
  await prisma.$transaction(async (tx) => {
    await tx.expenseClassification.update({
      where: { kind_parentName_name: { kind: "GROUP", parentName: "", name: oldName } },
      data: { name },
    });
    await tx.expenseClassification.updateMany({ where: { parentName: oldName }, data: { parentName: name } });
    await tx.accountPayable.updateMany({ where: { expenseGroup: oldName }, data: { expenseGroup: name } });
    await tx.invoice.updateMany({ where: { expenseGroup: oldName }, data: { expenseGroup: name } });
  });
}

/** Tira o grupo (e as categorias/descrições dele) das sugestões — contas já lançadas ficam como estão. */
export async function deleteExpenseGroup(rawName: string) {
  const name = requiredName(rawName);
  await prisma.expenseClassification.deleteMany({
    where: { OR: [{ kind: "GROUP", parentName: "", name }, { parentName: name, kind: { in: ["CATEGORY", "DESCRIPTION"] } }] },
  });
}

async function categoryInGroup(group: string, name: string) {
  return prisma.expenseClassification.findUnique({ where: { kind_parentName_name: { kind: "CATEGORY", parentName: group, name } } });
}

export async function createExpenseCategory(rawGroup: string, rawName: string) {
  const group = requiredName(rawGroup);
  const name = requiredName(rawName);
  if (!(await groupExists(group))) throw new HttpError(404, "Grupo não encontrado.");
  if (await categoryInGroup(group, name)) throw new HttpError(409, `A categoria ${name} já existe neste grupo.`);
  await prisma.expenseClassification.createMany({
    data: [
      { kind: "CATEGORY", name, parentName: group },
      { kind: "CATEGORY", name, parentName: "" },
    ],
    skipDuplicates: true,
  });
}

/** Renomeia a categoria dentro do grupo e nas contas a pagar já lançadas com esse grupo. */
export async function renameExpenseCategory(rawGroup: string, rawOldName: string, rawName: string) {
  const group = requiredName(rawGroup);
  const oldName = requiredName(rawOldName);
  const name = requiredName(rawName);
  if (oldName === name) return;
  if (!(await categoryInGroup(group, oldName))) throw new HttpError(404, "Categoria não encontrada neste grupo.");
  if (await categoryInGroup(group, name)) throw new HttpError(409, `A categoria ${name} já existe neste grupo.`);
  await prisma.$transaction(async (tx) => {
    await tx.expenseClassification.update({
      where: { kind_parentName_name: { kind: "CATEGORY", parentName: group, name: oldName } },
      data: { name },
    });
    await tx.expenseClassification.createMany({ data: [{ kind: "CATEGORY", name, parentName: "" }], skipDuplicates: true });
    await tx.accountPayable.updateMany({ where: { expenseGroup: group, category: oldName }, data: { category: name } });
  });
}

/** Tira a categoria das sugestões do grupo — contas já lançadas ficam como estão. */
export async function deleteExpenseCategory(rawGroup: string, rawName: string) {
  const group = requiredName(rawGroup);
  const name = requiredName(rawName);
  await prisma.expenseClassification.deleteMany({ where: { kind: "CATEGORY", parentName: group, name } });
}
