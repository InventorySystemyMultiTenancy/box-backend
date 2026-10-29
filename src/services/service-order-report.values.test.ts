import { describe, expect, it } from "vitest";
import { projectValues } from "@/services/service-order-report.service";

const approval = (status: string, laborValue: number | null, partsValue: number | null) => ({
  status,
  laborValue,
  partsValue,
  estimatedValue: (laborValue ?? 0) + (partsValue ?? 0),
});

describe("valores do PDF", () => {
  it("soma mão de obra e peças de tudo, menos o recusado", () => {
    const values = projectValues({
      approvals: [approval("PENDING", 3000, 0), approval("PENDING", null, 2730.4), approval("APPROVED", 500, 100), approval("REJECTED", 1000, 0)],
      estimatedMin: 9999,
      deliveryExtraValue: 50,
    });
    expect(values.laborTotal).toBe(3500);
    expect(values.partsTotal).toBeCloseTo(2830.4);
    expect(values.estimate).toBe(0);
    expect(values.total).toBeCloseTo(6380.4);
  });

  it("sem valores lançados, usa o estimado da abertura", () => {
    expect(projectValues({ approvals: [], estimatedMin: 800, deliveryExtraValue: null }).total).toBe(800);
  });
});
