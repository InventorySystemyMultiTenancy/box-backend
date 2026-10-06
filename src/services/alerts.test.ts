import { describe, expect, it } from "vitest";
import { planAlertSync } from "@/services/alerts.service";

const candidate = (type: string, entity: string, entityId: string, message = "msg") => ({ type, entity, entityId, message });
const stored = (id: string, type: string, entity: string, entityId: string, read = false, message = "msg") => ({
  id,
  type,
  entity,
  entityId,
  read,
  message,
});

describe("planAlertSync", () => {
  it("cria alerta novo quando a situação aparece", () => {
    const plan = planAlertSync([], [candidate("STALE_STATUS", "ServiceOrder", "os-1")]);
    expect(plan.create).toHaveLength(1);
    expect(plan.deleteIds).toEqual([]);
  });

  it("apaga alerta de situação que não existe mais (conta cancelada, projeto finalizado/excluído)", () => {
    const plan = planAlertSync(
      [stored("n1", "PAYABLE_OVERDUE", "AccountPayable", "cancelada"), stored("n2", "STALE_STATUS", "ServiceOrder", "excluida", true), stored("n3", "LOW_STOCK", "InventoryPart", "p")],
      []
    );
    expect(plan.deleteIds.sort()).toEqual(["n1", "n2", "n3"]);
    expect(plan.create).toEqual([]);
  });

  it("alerta marcado como lido NÃO volta enquanto a situação continuar", () => {
    const plan = planAlertSync([stored("n1", "STALE_STATUS", "ServiceOrder", "os-1", true)], [candidate("STALE_STATUS", "ServiceOrder", "os-1", "agora 5 dias")]);
    expect(plan.create).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.updates).toEqual([]);
  });

  it("atualiza a mensagem de alerta ainda não lido", () => {
    const plan = planAlertSync([stored("n1", "STALE_STATUS", "ServiceOrder", "os-1", false, "3 dias")], [candidate("STALE_STATUS", "ServiceOrder", "os-1", "4 dias")]);
    expect(plan.updates).toEqual([{ id: "n1", message: "4 dias" }]);
  });

  it("junta duplicados e prevalece o lido", () => {
    const plan = planAlertSync(
      [stored("n1", "STALE_STATUS", "ServiceOrder", "os-1", false), stored("n2", "STALE_STATUS", "ServiceOrder", "os-1", true), stored("n3", "STALE_STATUS", "ServiceOrder", "os-1", false)],
      [candidate("STALE_STATUS", "ServiceOrder", "os-1")]
    );
    expect(plan.deleteIds.sort()).toEqual(["n1", "n3"]);
    expect(plan.create).toEqual([]);
  });
});
