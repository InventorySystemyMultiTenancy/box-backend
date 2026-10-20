import { describe, expect, it } from "vitest";
import { parseMoneyFilter } from "@/services/accounts-payable.service";

describe("parseMoneyFilter", () => {
  it("aceita valor no formato brasileiro e com ponto decimal", () => {
    expect(parseMoneyFilter("1.234,56")).toBe(1234.56);
    expect(parseMoneyFilter("150,5")).toBe(150.5);
    expect(parseMoneyFilter("R$ 150")).toBe(150);
    expect(parseMoneyFilter("1234.56")).toBe(1234.56);
  });

  it("devolve null quando não é número", () => {
    expect(parseMoneyFilter("abc")).toBeNull();
    expect(parseMoneyFilter("   ")).toBeNull();
  });
});
