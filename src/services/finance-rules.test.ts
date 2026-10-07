import { describe, expect, it } from "vitest";
import { isDuplicatedOrderIncome, orderBillingTotal, parseSettlementDate, roundMoney, SettlementDateError, splitInstallments, summarizeSettlementGroups } from "@/services/finance-rules";

describe("summarizeSettlementGroups", () => {
  it("em aberto = pendentes + vencidas; vencidas à parte; quitado usa o valor efetivamente pago", () => {
    const summary = summarizeSettlementGroups(
      [
        { status: "PENDING", amount: 100.1, count: 2 },
        { status: "OVERDUE", amount: 50.2, count: 1 },
        { status: "PAID", amount: 300, count: 3 },
      ],
      295.5,
      "PAID"
    );
    expect(summary).toEqual({
      open: { total: 150.3, count: 3 },
      overdue: { total: 50.2, count: 1 },
      settled: { total: 295.5, count: 3 },
    });
  });

  it("sem contas, tudo zerado", () => {
    expect(summarizeSettlementGroups([], 0, "RECEIVED")).toEqual({
      open: { total: 0, count: 0 },
      overdue: { total: 0, count: 0 },
      settled: { total: 0, count: 0 },
    });
  });
});

describe("parseSettlementDate", () => {
  const now = new Date(2026, 9, 7, 15, 30);

  it("sem data usa o momento atual", () => {
    expect(parseSettlementDate(undefined, now)).toBe(now);
  });

  it("data escolhida fica ao meio-dia (não vira o dia anterior no fuso de Brasília)", () => {
    const d = parseSettlementDate("2026-10-03", now);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 9, 3, 12]);
  });

  it("aceita hoje e recusa data futura ou inválida", () => {
    expect(parseSettlementDate("2026-10-07", now).getDate()).toBe(7);
    expect(() => parseSettlementDate("2026-10-08", now)).toThrow(SettlementDateError);
    expect(() => parseSettlementDate("não é data", now)).toThrow(SettlementDateError);
  });
});

describe("roundMoney", () => {
  it("arredonda para centavos sem erro de float", () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(10)).toBe(10);
  });
});

describe("splitInstallments", () => {
  it("à vista gera uma parcela com o valor cheio", () => {
    const [only, ...rest] = splitInstallments(250, 1, new Date(2026, 0, 10));
    expect(rest).toHaveLength(0);
    expect(only.amount).toBe(250);
    expect(only.number).toBe(1);
  });

  it("parcelas somam exatamente o total, com a diferença na última", () => {
    const parts = splitInstallments(100, 3, new Date(2026, 0, 10));
    expect(parts.map((p) => p.amount)).toEqual([33.33, 33.33, 33.34]);
    expect(roundMoney(parts.reduce((s, p) => s + p.amount, 0))).toBe(100);
  });

  it("vence em meses consecutivos a partir da primeira data", () => {
    const parts = splitInstallments(90, 3, new Date(2026, 0, 10));
    expect(parts.map((p) => p.dueDate.getMonth())).toEqual([0, 1, 2]);
    expect(parts.every((p) => p.dueDate.getDate() === 10)).toBe(true);
  });

  it("quantidade inválida vira 1 parcela", () => {
    expect(splitInstallments(50, 0, new Date())).toHaveLength(1);
  });
});

describe("orderBillingTotal", () => {
  const done = { status: "PENDING", estimatedValue: 200, part: { status: "DONE" } };

  it("soma só problemas concluídos, aprovados ou sem resposta do cliente", () => {
    const total = orderBillingTotal(
      [done, { status: "APPROVED", estimatedValue: 100, part: { status: "DONE" } }, { status: "APPROVED", estimatedValue: 999, part: { status: "IN_PROGRESS" } }],
      null
    );
    expect(total).toBe(300);
  });

  it("ignora o que o cliente reprovou, mesmo que o componente esteja concluído", () => {
    expect(orderBillingTotal([done, { status: "REJECTED", estimatedValue: 500, part: { status: "DONE" } }], null)).toBe(200);
  });

  it("sem problema precificado usa o valor inicial estimado", () => {
    expect(orderBillingTotal([], 150)).toBe(150);
  });

  it("soma o valor extra da entrega", () => {
    expect(orderBillingTotal([done], null, 49.9)).toBe(249.9);
  });
});

describe("isDuplicatedOrderIncome", () => {
  const billed = new Set(["os-1"]);

  it("descarta a receita antiga de uma OS que já tem conta a receber", () => {
    expect(isDuplicatedOrderIncome({ type: "INCOME", category: "PROJETO", serviceOrderId: "os-1" }, billed)).toBe(true);
    expect(isDuplicatedOrderIncome({ type: "INCOME", category: "ENTREGA_EXTRA", serviceOrderId: "os-1" }, billed)).toBe(true);
  });

  it("mantém a receita antiga de OS sem conta a receber", () => {
    expect(isDuplicatedOrderIncome({ type: "INCOME", category: "PROJETO", serviceOrderId: "os-2" }, billed)).toBe(false);
  });

  it("nunca descarta despesas nem outras categorias", () => {
    expect(isDuplicatedOrderIncome({ type: "EXPENSE", category: "PROJETO", serviceOrderId: "os-1" }, billed)).toBe(false);
    expect(isDuplicatedOrderIncome({ type: "INCOME", category: "LUCRO_PDV", serviceOrderId: "os-1" }, billed)).toBe(false);
  });
});
