import fs from "fs";

export class TruckVisionError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface RecognizedTruckPanel {
  km: number | null;
  fuelLevel: string | null;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

export interface RecognizedFuelPump {
  amountPaid: number | null;
  liters: number | null;
  pricePerLiter: number | null;
  confidence: "LOW" | "MEDIUM" | "HIGH";
}

// Mesmo provider/modelo já usado em invoice-ocr.service.ts e vehicle-recognition.service.ts
// — reaproveitado por consistência, em vez de introduzir um segundo provedor de IA.
const OPENAI_MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o-mini";

async function callVisionModel(filePath: string, mimetype: string, systemPrompt: string, userPrompt: string): Promise<Record<string, unknown>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new TruckVisionError("Leitura automática por IA não configurada (defina OPENAI_API_KEY no ambiente).", 501);
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
      max_tokens: 400,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userPrompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new TruckVisionError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new TruckVisionError("A IA não retornou dados legíveis para esta imagem.", 502);

  try {
    return JSON.parse(content);
  } catch {
    throw new TruckVisionError("A IA retornou um formato inesperado.", 502);
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const confidence = (v: unknown) => (["LOW", "MEDIUM", "HIGH"].includes(v as string) ? (v as "LOW" | "MEDIUM" | "HIGH") : "LOW");

const PANEL_PROMPT = `Analise esta foto do painel/quadro de instrumentos de um caminhão e responda APENAS com um JSON válido, sem markdown, no formato:
{
  "km": <número inteiro da quilometragem total mostrada no hodômetro, ou null se não estiver legível>,
  "fuelLevel": "<nível de combustível mostrado no marcador, ex: '3/4', '1/2', '1/4', 'Cheio', 'Reserva', ou null se não visível>",
  "confidence": "LOW" | "MEDIUM" | "HIGH"
}
"confidence" reflete o quão nítido e legível está o hodômetro na foto. Responda só o JSON, nada mais.`;

const PUMP_PROMPT = `Analise esta foto do visor de uma bomba de combustível (posto de gasolina) e responda APENAS com um JSON válido, sem markdown, no formato:
{
  "amountPaid": <valor total em reais mostrado no visor, número, ou null se não legível>,
  "liters": <quantidade de litros abastecidos mostrada no visor, número, ou null se não legível>,
  "pricePerLiter": <preço por litro mostrado no visor, número, ou null se não visível>,
  "confidence": "LOW" | "MEDIUM" | "HIGH"
}
"confidence" reflete o quão nítido e legível está o visor na foto. Responda só o JSON, nada mais.`;

// Lê a foto do painel do caminhão (tirada ao iniciar/finalizar a pilotagem) e devolve
// a km do hodômetro para pré-preencher o formulário — o motorista confere/ajusta antes
// de salvar, nada é gravado aqui.
export async function recognizeTruckPanel(filePath: string, mimetype: string): Promise<RecognizedTruckPanel> {
  const parsed = await callVisionModel(
    filePath,
    mimetype,
    "Você lê o hodômetro e o marcador de combustível de painéis de caminhão a partir de fotos. Responda sempre com JSON válido.",
    PANEL_PROMPT
  );
  const km = num(parsed.km);
  return {
    km: km != null ? Math.round(km) : null,
    fuelLevel: str(parsed.fuelLevel),
    confidence: confidence(parsed.confidence),
  };
}

// Lê a foto do visor da bomba de combustível e devolve valor pago/litros/preço por
// litro para pré-preencher o abastecimento — o motorista confere/ajusta antes de salvar.
export async function recognizeFuelPump(filePath: string, mimetype: string): Promise<RecognizedFuelPump> {
  const parsed = await callVisionModel(
    filePath,
    mimetype,
    "Você lê visores de bombas de combustível (valor pago, litros, preço por litro) a partir de fotos. Responda sempre com JSON válido.",
    PUMP_PROMPT
  );
  return {
    amountPaid: num(parsed.amountPaid),
    liters: num(parsed.liters),
    pricePerLiter: num(parsed.pricePerLiter),
    confidence: confidence(parsed.confidence),
  };
}
