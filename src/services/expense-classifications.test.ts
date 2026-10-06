import { describe, expect, it } from "vitest";
import { normalizeClassification, rememberExpenseClassification } from "@/services/expense-classifications.service";
import { payableDisplayDescription } from "@/services/accounts-payable.service";

describe("normalizeClassification", () => {
  it("tira espaços extras e descarta campos vazios", () => {
    expect(normalizeClassification({ category: "  Folha  de pagamento ", group: "", description: "   ", sector: "Administração" })).toEqual({
      category: "Folha de pagamento",
      group: undefined,
      description: undefined,
      sector: "Administração",
    });
  });
});

describe("rememberExpenseClassification", () => {
  it("salva categoria, grupo, descrição (filha do grupo) e setor", async () => {
    const saved: unknown[] = [];
    const db = { expenseClassification: { createMany: async ({ data }: { data: unknown[] }) => saved.push(...data) } } as never;
    await rememberExpenseClassification(db, { category: "Despesas fixas", group: "FOLHA DE PAGAMENTO", description: "ASSISTÊNCIA MÉDICA", sector: "Administração" });
    expect(saved).toEqual([
      { kind: "CATEGORY", name: "Despesas fixas", parentName: "" },
      { kind: "GROUP", name: "FOLHA DE PAGAMENTO", parentName: "" },
      { kind: "DESCRIPTION", name: "ASSISTÊNCIA MÉDICA", parentName: "FOLHA DE PAGAMENTO" },
      { kind: "SECTOR", name: "Administração", parentName: "" },
    ]);
  });

  it("não faz nada sem classificação", async () => {
    let called = false;
    const db = { expenseClassification: { createMany: async () => (called = true) } } as never;
    await rememberExpenseClassification(db, {});
    expect(called).toBe(false);
  });
});

describe("payableDisplayDescription", () => {
  it("usa a descrição digitada quando houver", () => {
    expect(payableDisplayDescription({ description: "Aluguel outubro", category: "FIXAS", payeeName: "Imobiliária" })).toBe("Aluguel outubro");
  });

  it("monta a partir da descrição da despesa, fornecedor e nota", () => {
    expect(
      payableDisplayDescription({ expenseDescription: "ASSISTÊNCIA MÉDICA", expenseGroup: "FOLHA DE PAGAMENTO", category: "X", payeeName: "AMIL SAÚDE", invoiceNumber: "123" })
    ).toBe("ASSISTÊNCIA MÉDICA — AMIL SAÚDE — NF 123");
  });

  it("cai no grupo e depois na categoria", () => {
    expect(payableDisplayDescription({ expenseGroup: "FOLHA", category: "X", payeeName: "Fulano" })).toBe("FOLHA — Fulano");
    expect(payableDisplayDescription({ category: "ALUGUEL", payeeName: "Fulano" })).toBe("ALUGUEL — Fulano");
  });
});
