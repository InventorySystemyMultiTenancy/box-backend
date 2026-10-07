import { describe, expect, it } from "vitest";
import { canSeeAlertType, canSeeSection, canSeeSector, ReportAccess } from "@/lib/report-access";
import { filterAlertsForAccess } from "@/services/alerts.service";

const everything: ReportAccess = { sections: null, sectors: null, alertTypes: null };

describe("acesso por cargo", () => {
  it("cargo sem restrição vê tudo", () => {
    expect(canSeeSection(everything, "financial")).toBe(true);
    expect(canSeeAlertType(everything, "PAYABLE_OVERDUE")).toBe(true);
    expect(canSeeSector(everything, null)).toBe(true);
  });

  it("blocos e tipos de alerta restritos", () => {
    const access: ReportAccess = { sections: ["productivity"], sectors: null, alertTypes: ["STALE_STATUS"] };
    expect(canSeeSection(access, "productivity")).toBe(true);
    expect(canSeeSection(access, "financial")).toBe(false);
    expect(canSeeAlertType(access, "STALE_STATUS")).toBe(true);
    expect(canSeeAlertType(access, "PAYABLE_OVERDUE")).toBe(false);
  });

  it("setor compara sem diferenciar maiúsculas/espaços e despesa sem setor fica de fora", () => {
    const access: ReportAccess = { sections: null, sectors: ["Oficina"], alertTypes: null };
    expect(canSeeSector(access, " oficina ")).toBe(true);
    expect(canSeeSector(access, "Administração")).toBe(false);
    expect(canSeeSector(access, null)).toBe(false);
  });

  it("filtra alertas pelo tipo (sem setor configurado não consulta o banco)", async () => {
    const alerts = [
      { type: "STALE_STATUS", entity: "ServiceOrder", entityId: "os" },
      { type: "PAYABLE_OVERDUE", entity: "AccountPayable", entityId: "conta" },
    ];
    const result = await filterAlertsForAccess(alerts, { sections: null, sectors: null, alertTypes: ["STALE_STATUS"] });
    expect(result.map((a) => a.type)).toEqual(["STALE_STATUS"]);
  });
});
