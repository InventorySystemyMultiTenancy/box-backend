import fs from "fs";

export class InvoiceOcrError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface ExtractedInvoiceData {
  type: "NFE" | "NFSE" | "NFCE";
  number: string | null;
  series: string | null;
  accessKey: string | null;
  operationNature: string | null;
  issuerName: string | null;
  issuerDocument: string | null;
  recipientName: string | null;
  recipientDocument: string | null;
  paymentMethod: string | null;
  description: string;
  totalAmount: number | null;
  discountAmount: number | null;
  taxAmount: number | null;
  issueDate: string | null;
}

const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

const EXTRACTION_PROMPT = `Extraia os dados desta nota fiscal brasileira (foto ou print) e responda APENAS com um JSON válido, sem markdown, no formato:
{
  "type": "NFE" | "NFSE" | "NFCE",
  "number": "<número da nota, só dígitos, ou null>",
  "series": "<série da nota, ou null>",
  "accessKey": "<chave de acesso de 44 dígitos, se visível, ou null>",
  "operationNature": "<natureza da operação, ex: 'Venda de mercadoria' ou 'Prestação de serviço', ou null>",
  "issuerName": "<nome/razão social de quem EMITIU a nota, ou null>",
  "issuerDocument": "<CNPJ ou CPF do emitente, só dígitos, ou null>",
  "recipientName": "<nome/razão social do destinatário/tomador, ou null>",
  "recipientDocument": "<CNPJ ou CPF do destinatário, só dígitos, ou null>",
  "paymentMethod": "<forma de pagamento se visível, ex: 'PIX', 'Dinheiro', 'Cartão de crédito', ou null>",
  "description": "<discriminação resumida dos produtos/serviços, ex: 'Troca de bomba d'água e pastilhas de freio'>",
  "totalAmount": <número, valor total em reais, sem formatação, ex: 1234.56>,
  "discountAmount": <número, valor de desconto se houver, senão 0>,
  "taxAmount": <número, soma de impostos destacados (ICMS/ISS/etc) se houver, senão 0>,
  "issueDate": "<data de emissão YYYY-MM-DD, ou null>"
}
"type": use NFSE para nota de serviço, NFE para nota de produto/mercadoria, NFCE para cupom fiscal de consumidor.
Se algum campo não for legível na imagem, use null (ou 0 para valores numéricos). Responda só o JSON, nada mais.`;

// Lê uma nota fiscal fotografada/escaneada via OpenAI Vision e devolve os campos já
// estruturados para pré-preencher o formulário — o usuário confere e confirma antes
// de qualquer coisa ser salva (esta função não grava nada no banco).
export async function extractInvoiceFromImage(filePath: string, mimetype: string): Promise<ExtractedInvoiceData> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new InvoiceOcrError("Leitura automática por IA não configurada (defina OPENAI_API_KEY no ambiente).", 501);
  }

  const buffer = await fs.promises.readFile(filePath);
  const dataUrl = `data:${mimetype};base64,${buffer.toString("base64")}`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 700,
      messages: [
        {
          role: "system",
          content: "Você extrai dados estruturados de notas fiscais brasileiras a partir de imagens. Responda sempre com JSON válido.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACTION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new InvoiceOcrError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new InvoiceOcrError("A IA não retornou dados legíveis para esta imagem.", 502);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InvoiceOcrError("A IA retornou um formato inesperado.", 502);
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : null);
  const type = ["NFE", "NFSE", "NFCE"].includes(parsed.type as string) ? (parsed.type as "NFE" | "NFSE" | "NFCE") : "NFSE";

  return {
    type,
    number: str(parsed.number),
    series: str(parsed.series),
    accessKey: str(parsed.accessKey),
    operationNature: str(parsed.operationNature),
    issuerName: str(parsed.issuerName),
    issuerDocument: str(parsed.issuerDocument),
    recipientName: str(parsed.recipientName),
    recipientDocument: str(parsed.recipientDocument),
    paymentMethod: str(parsed.paymentMethod),
    description: str(parsed.description) ?? "Nota fiscal (extraída por IA)",
    totalAmount: num(parsed.totalAmount),
    discountAmount: num(parsed.discountAmount),
    taxAmount: num(parsed.taxAmount),
    issueDate: str(parsed.issueDate),
  };
}
