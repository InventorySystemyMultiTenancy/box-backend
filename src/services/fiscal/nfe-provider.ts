// Contrato para gateways de emissão fiscal (NF-e/NFS-e/NFC-e). Um provider real
// (eNotas, Focus NFe, NFe.io...) precisa de certificado digital e contrato com a
// prefeitura/SEFAZ, que este projeto não tem — MockNFeProvider (mock-provider.ts)
// implementa esta mesma interface para dev/demo, sem dependência externa.
export interface IssueInput {
  type: "NFE" | "NFSE" | "NFCE";
  totalAmount: number;
  clientName?: string;
  description: string;
}

export interface IssueResult {
  number: string;
  series: string;
  providerRef: string;
  xmlUrl?: string;
  pdfUrl?: string;
}

export interface NFeProvider {
  readonly name: string;
  issue(input: IssueInput): Promise<IssueResult>;
  cancel(providerRef: string): Promise<void>;
}
