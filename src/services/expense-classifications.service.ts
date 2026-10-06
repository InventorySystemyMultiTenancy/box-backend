import { prisma, AppTx } from "@/lib/prisma";

// Cadastro das classificações de despesa (categoria/natureza, grupo, descrição e setor). Não
// há tela própria: o que é digitado ao lançar uma conta a pagar ou nota de despesa fica
// salvo aqui e volta como sugestão nos próximos lançamentos.

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
  if (c.group) rows.push({ kind: "GROUP", name: c.group, parentName: "" });
  if (c.description) rows.push({ kind: "DESCRIPTION", name: c.description, parentName: c.group ?? "" });
  if (c.sector) rows.push({ kind: "SECTOR", name: c.sector, parentName: "" });
  if (rows.length > 0) await db.expenseClassification.createMany({ data: rows, skipDuplicates: true });
}

export async function listExpenseClassifications() {
  const rows = await prisma.expenseClassification.findMany({ orderBy: { name: "asc" } });
  const names = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => r.name);
  return {
    categories: names("CATEGORY"),
    groups: names("GROUP"),
    sectors: names("SECTOR"),
    // Descrição pertence a um grupo (ASSISTÊNCIA MÉDICA → FOLHA DE PAGAMENTO); "" = sem grupo.
    descriptions: rows.filter((r) => r.kind === "DESCRIPTION").map((r) => ({ group: r.parentName, name: r.name })),
  };
}
