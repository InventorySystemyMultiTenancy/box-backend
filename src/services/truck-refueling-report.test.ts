import { describe, expect, it } from "vitest";
import { brtDay, buildRefuelingReport, periodRange, type RefuelingRow } from "@/services/truck-refueling-report.service";

function row(partial: Partial<RefuelingRow> & Pick<RefuelingRow, "id" | "createdAt" | "currentKm" | "liters" | "amountPaid">): RefuelingRow {
  return {
    truckId: "t1",
    truck: { plate: "ABC1D23", brand: "VW", model: "Delivery" },
    driverId: "d1",
    driver: { name: "João" },
    referenceKm: 1000,
    pricePerLiter: null,
    ...partial,
  };
}

const period = { from: "2026-10-01", to: "2026-10-31" };

describe("periodRange", () => {
  it("usa os dias de Brasília (03:00 UTC) e conta os dias do período", () => {
    const { start, end, days } = periodRange(period);
    expect(start.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-01T03:00:00.000Z");
    expect(days).toBe(31);
  });

  it("recusa data final antes da inicial", () => {
    expect(() => periodRange({ from: "2026-10-10", to: "2026-10-01" })).toThrow();
  });
});

describe("brtDay", () => {
  it("abastecimento às 01:00 UTC ainda é o dia anterior em Brasília", () => {
    expect(brtDay(new Date("2026-10-02T01:00:00Z"))).toBe("2026-10-01");
  });
});

describe("buildRefuelingReport", () => {
  it("calcula km rodado de um abastecimento ao outro, consumo e totais por caminhão e motorista", () => {
    const report = buildRefuelingReport(
      [
        row({ id: "a", createdAt: new Date("2026-10-02T12:00:00Z"), currentKm: 1400, liters: 40, amountPaid: 240 }),
        row({ id: "b", createdAt: new Date("2026-10-05T12:00:00Z"), currentKm: 1800, liters: 50, amountPaid: 300, driverId: "d2", driver: { name: "Maria" } }),
        row({
          id: "c",
          createdAt: new Date("2026-10-05T15:00:00Z"),
          truckId: "t2",
          truck: { plate: "XYZ9K87", brand: null, model: null },
          currentKm: 500,
          referenceKm: 300,
          liters: 20,
          amountPaid: 130,
        }),
      ],
      new Map([["t1", 1000]]),
      period
    );

    expect(report.entries.map((e) => e.kmSincePrevious)).toEqual([400, 400, 200]);
    expect(report.entries.map((e) => e.kmPerLiter)).toEqual([10, 8, 10]);
    expect(report.totals).toMatchObject({ refuelings: 3, liters: 110, amount: 670, km: 1000, trucks: 2, drivers: 2, daysWithRefueling: 2 });

    const t1 = report.trucks.find((t) => t.plate === "ABC1D23")!;
    expect(t1).toMatchObject({ refuelings: 2, amount: 540, km: 800, avgKmPerLiter: 8.89, avgKmBetweenRefuelings: 400, firstKm: 1400, lastKm: 1800 });
    expect(report.trucks[0].plate).toBe("ABC1D23"); // maior gasto primeiro

    expect(report.drivers[0]).toMatchObject({ name: "João", refuelings: 2, trucks: ["ABC1D23", "XYZ9K87"] });
    expect(report.topDays[0]).toMatchObject({ date: "2026-10-05", refuelings: 2, amount: 430 });
    expect(report.weekdays[1]).toMatchObject({ label: "Segunda", refuelings: 2 }); // 05/10/2026 é segunda
  });

  it("aponta km menor que o anterior e não conta km rodado nele", () => {
    const report = buildRefuelingReport(
      [row({ id: "a", createdAt: new Date("2026-10-02T12:00:00Z"), currentKm: 900, liters: 40, amountPaid: 240 })],
      new Map([["t1", 1000]]),
      period
    );
    expect(report.entries[0].kmSincePrevious).toBeNull();
    expect(report.totals.km).toBe(0);
    expect(report.totals.avgKmPerLiter).toBeNull();
    expect(report.alerts[0].message).toContain("menor que o do abastecimento anterior");
  });

  it("período sem abastecimento devolve tudo zerado", () => {
    const report = buildRefuelingReport([], new Map(), period);
    expect(report.totals).toMatchObject({ refuelings: 0, amount: 0, avgAmountPerDay: 0, cheapest: null });
    expect(report.trucks).toEqual([]);
  });
});
