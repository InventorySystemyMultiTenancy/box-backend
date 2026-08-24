import fs from "fs";

export class VehicleRecognitionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface DetectedProblem {
  description: string;
  location: string | null;
  severity: "LOW" | "MEDIUM" | "HIGH" | null;
}

export interface RecognizedVehicleData {
  brand: string | null;
  model: string | null;
  year: number | null;
  color: string | null;
  plate: string | null;
  visibleProblems: DetectedProblem[];
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

// Mesmo provider/modelo já usado em services/fiscal/invoice-ocr.service.ts (leitura de
// nota fiscal por IA) — reaproveitado aqui por consistência, em vez de introduzir um
// segundo provedor de IA no projeto.
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

const RECOGNITION_PROMPT = `Analise esta foto de um veículo recebido em uma oficina mecânica e responda APENAS com um JSON válido, sem markdown, no formato:
{
  "brand": "<marca do veículo, ex: 'Honda', ou null se não identificável>",
  "model": "<modelo, ex: 'Civic', ou null se não identificável>",
  "year": <ano aproximado (número) do modelo/geração, ou null>,
  "color": "<cor predominante da carroceria, ou null>",
  "plate": "<placa visível na foto (formato brasileiro, Mercosul ou antigo), ou null se não legível>",
  "visibleProblems": [
    { "description": "<problema visível, ex: 'Amassado no para-choque dianteiro'>", "location": "<local no veículo, ou null>", "severity": "LOW" | "MEDIUM" | "HIGH" }
  ],
  "confidence": "LOW" | "MEDIUM" | "HIGH"
}
Liste em "visibleProblems" APENAS danos realmente visíveis na foto (arranhões, amassados, quebras, vazamentos, pneus carecas, etc.) — se nada estiver visivelmente danificado, use uma lista vazia []. Não invente problemas. "confidence" reflete o quão claro/nítido está o veículo na foto para identificação de marca/modelo/placa. Responda só o JSON, nada mais.`;

// Lê uma foto do veículo via IA com visão e devolve marca/modelo/placa + danos visíveis
// já estruturados, para pré-preencher o cadastro — nada é gravado no banco aqui, quem
// chama decide o que fazer com o resultado (o usuário confere antes de salvar).
export async function recognizeVehicleFromImage(filePath: string, mimetype: string): Promise<RecognizedVehicleData> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new VehicleRecognitionError("Leitura automática por IA não configurada (defina OPENAI_API_KEY no ambiente).", 501);
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
          content: "Você identifica veículos e danos visíveis a partir de fotos para uma oficina mecânica. Responda sempre com JSON válido.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: RECOGNITION_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new VehicleRecognitionError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new VehicleRecognitionError("A IA não retornou dados legíveis para esta imagem.", 502);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new VehicleRecognitionError("A IA retornou um formato inesperado.", 502);
  }

  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const num = (v: unknown) => (typeof v === "number" && v > 1900 ? v : null);
  const severity = (v: unknown) => (["LOW", "MEDIUM", "HIGH"].includes(v as string) ? (v as "LOW" | "MEDIUM" | "HIGH") : null);
  const confidence = ["LOW", "MEDIUM", "HIGH"].includes(parsed.confidence as string) ? (parsed.confidence as "LOW" | "MEDIUM" | "HIGH") : "LOW";

  const rawProblems = Array.isArray(parsed.visibleProblems) ? parsed.visibleProblems : [];
  const visibleProblems: DetectedProblem[] = rawProblems
    .map((p) => (p && typeof p === "object" ? (p as Record<string, unknown>) : null))
    .filter((p): p is Record<string, unknown> => p !== null && Boolean(str(p.description)))
    .map((p) => ({
      description: str(p.description)!,
      location: str(p.location),
      severity: severity(p.severity),
    }));

  return {
    brand: str(parsed.brand),
    model: str(parsed.model),
    year: num(parsed.year),
    color: str(parsed.color),
    plate: str(parsed.plate),
    visibleProblems,
    confidence,
  };
}
