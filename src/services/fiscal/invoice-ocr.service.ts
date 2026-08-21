import fs from "fs";

export class InvoiceOcrError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface ExtractedInvoiceData {
  type: "NFE" | "NFSE" | "NFCE";
  totalAmount: number | null;
  description: string;
  issueDate: string | null;
  clientNameGuess: string | null;
}

const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

const EXTRACTION_PROMPT = `Extraia os dados desta nota fiscal brasileira (foto ou print) e responda APENAS com um JSON válido, sem markdown, no formato:
{
  "type": "NFE" | "NFSE" | "NFCE",
  "totalAmount": <número, valor total em reais, sem formatação, ex: 1234.56>,
  "description": "<string curta: número da nota + emitente, ex: 'NF 12345 - AutoPeças SP Ltda'>",
  "issueDate": "<data de emissão YYYY-MM-DD, ou null se não estiver visível>",
  "clientNameGuess": "<nome do destinatário/tomador do serviço, ou null se não estiver visível>"
}
"type": use NFSE para nota de serviço, NFE para nota de produto/mercadoria, NFCE para cupom fiscal de consumidor.
Se algum campo não for legível na imagem, use null (ou 0 para totalAmount). Responda só o JSON, nada mais.`;

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
      max_tokens: 500,
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

  const type = ["NFE", "NFSE", "NFCE"].includes(parsed.type as string) ? (parsed.type as "NFE" | "NFSE" | "NFCE") : "NFSE";
  const totalAmount = typeof parsed.totalAmount === "number" && parsed.totalAmount > 0 ? parsed.totalAmount : null;

  return {
    type,
    totalAmount,
    description: typeof parsed.description === "string" && parsed.description.trim() ? parsed.description.trim() : "Nota fiscal (extraída por IA)",
    issueDate: typeof parsed.issueDate === "string" ? parsed.issueDate : null,
    clientNameGuess: typeof parsed.clientNameGuess === "string" ? parsed.clientNameGuess : null,
  };
}
