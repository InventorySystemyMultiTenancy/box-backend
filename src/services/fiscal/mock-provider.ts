import { randomUUID } from "crypto";
import { IssueInput, IssueResult, NFeProvider } from "@/services/fiscal/nfe-provider";

// Provider padrão em dev/sem contrato fiscal: "emite" localmente, gerando número
// sequencial e uma referência opaca, sem chamar nenhum serviço externo.
let sequence = 1;

export class MockNFeProvider implements NFeProvider {
  readonly name = "MOCK";

  async issue(_input: IssueInput): Promise<IssueResult> {
    const number = String(sequence++).padStart(9, "0");
    const providerRef = randomUUID();
    return {
      number,
      series: "1",
      providerRef,
      xmlUrl: undefined,
      pdfUrl: undefined,
    };
  }

  async cancel(_providerRef: string): Promise<void> {
    // Sem estado externo a reverter no mock — cancelamento é só o status local no banco.
  }
}
