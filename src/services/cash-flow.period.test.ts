import { describe, expect, it } from "vitest";
import { endOfPeriod } from "@/services/cash-flow.service";

describe("endOfPeriod", () => {
  it("data sem hora inclui o dia inteiro", () => {
    const end = endOfPeriod("2026-10-06");
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    expect(end.getDate()).toBe(6);
  });

  it("data com hora é respeitada como veio", () => {
    expect(endOfPeriod("2026-10-06T10:00:00.000Z").toISOString()).toBe("2026-10-06T10:00:00.000Z");
  });
});
