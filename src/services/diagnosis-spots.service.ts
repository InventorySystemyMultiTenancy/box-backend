// Diagnóstico único do projeto: a IA lê o serviço + a descrição do diagnóstico e marca no
// modelo do veículo (imagem raio-X vista de cima, 300×520 — VehicleSchematic no front) os
// pontos onde os problemas foram identificados. Cada ponto guarda o trecho da descrição
// que fala dele e o motivo que levou a IA a marcar ali (mostrados no balão ao clicar).
//
// A IA escolhe REGIÕES de uma lista fixa (não coordenadas soltas): assim a bolinha cai
// sempre em cima da peça certa do desenho, e uma resposta estranha da IA não joga ponto
// para fora do carro.

const OPENAI_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
const TIMEOUT_MS = 25_000;
const MAX_SPOTS = 10;

export interface DiagnosisSpot {
  zone: string;
  label: string;
  x: number;
  y: number;
  excerpt: string;
  reason: string;
}

// Coordenadas no SVG 300×520 do VehicleSchematic (frente do carro no topo, lado esquerdo
// = lado do motorista à esquerda da imagem).
export const VEHICLE_ZONES: Record<string, { label: string; x: number; y: number }> = {
  parachoque_dianteiro: { label: "Para-choque dianteiro", x: 150, y: 34 },
  farol_esquerdo: { label: "Farol esquerdo", x: 94, y: 54 },
  farol_direito: { label: "Farol direito", x: 206, y: 54 },
  radiador_arrefecimento: { label: "Radiador / arrefecimento", x: 150, y: 60 },
  motor: { label: "Motor", x: 150, y: 94 },
  bateria: { label: "Bateria", x: 106, y: 112 },
  central_eletrica: { label: "Parte elétrica / central", x: 194, y: 112 },
  paralama_dianteiro_esquerdo: { label: "Para-lama dianteiro esquerdo", x: 80, y: 100 },
  paralama_dianteiro_direito: { label: "Para-lama dianteiro direito", x: 220, y: 100 },
  para_brisa: { label: "Para-brisa", x: 150, y: 150 },
  roda_dianteira_esquerda: { label: "Roda dianteira esquerda (pneu, freio, suspensão)", x: 68, y: 132 },
  roda_dianteira_direita: { label: "Roda dianteira direita (pneu, freio, suspensão)", x: 232, y: 132 },
  retrovisor_esquerdo: { label: "Retrovisor esquerdo", x: 64, y: 166 },
  retrovisor_direito: { label: "Retrovisor direito", x: 236, y: 166 },
  painel_ar_condicionado: { label: "Painel / ar-condicionado", x: 150, y: 184 },
  direcao: { label: "Direção / volante", x: 116, y: 200 },
  porta_dianteira_esquerda: { label: "Porta dianteira esquerda", x: 78, y: 242 },
  porta_dianteira_direita: { label: "Porta dianteira direita", x: 222, y: 242 },
  interior_bancos: { label: "Interior / bancos", x: 150, y: 232 },
  cambio_transmissao: { label: "Câmbio / transmissão", x: 150, y: 270 },
  teto: { label: "Teto", x: 150, y: 300 },
  porta_traseira_esquerda: { label: "Porta traseira esquerda", x: 78, y: 320 },
  porta_traseira_direita: { label: "Porta traseira direita", x: 222, y: 320 },
  roda_traseira_esquerda: { label: "Roda traseira esquerda (pneu, freio, suspensão)", x: 70, y: 386 },
  roda_traseira_direita: { label: "Roda traseira direita (pneu, freio, suspensão)", x: 230, y: 386 },
  lateral_traseira_esquerda: { label: "Lateral traseira esquerda", x: 78, y: 428 },
  lateral_traseira_direita: { label: "Lateral traseira direita", x: 222, y: 428 },
  tanque_combustivel: { label: "Tanque / combustível", x: 188, y: 362 },
  vidro_traseiro: { label: "Vidro traseiro", x: 150, y: 402 },
  escapamento: { label: "Escapamento", x: 150, y: 432 },
  porta_malas: { label: "Porta-malas", x: 150, y: 462 },
  lanterna_esquerda: { label: "Lanterna esquerda", x: 96, y: 474 },
  lanterna_direita: { label: "Lanterna direita", x: 204, y: 474 },
  parachoque_traseiro: { label: "Para-choque traseiro", x: 150, y: 488 },
  carroceria_geral: { label: "Veículo em geral", x: 150, y: 340 },
};

const SYSTEM_PROMPT = `Você é um mecânico automotivo experiente. Recebe o SERVIÇO e a DESCRIÇÃO DO DIAGNÓSTICO de um veículo, escritos por um funcionário da oficina, e marca no desenho do carro (visto de cima) ONDE estão os problemas descritos.

Regiões disponíveis (use SOMENTE estes ids):
${Object.entries(VEHICLE_ZONES)
  .map(([id, z]) => `- ${id}: ${z.label}`)
  .join("\n")}

Regras:
- Um ponto para cada local diferente com problema. Se o mesmo problema está em dois lados (ex.: "pastilhas dianteiras gastas"), marque os dois lados.
- Lado esquerdo = lado do motorista; direito = lado do passageiro.
- Se a descrição não diz o lado/eixo, escolha o local mais provável pelo tipo de problema e diga no motivo que é uma estimativa.
- Use "carroceria_geral" só quando o problema não tiver um local no carro (ex.: revisão geral).
- "excerpt": copie EXATAMENTE o trecho da descrição (palavra por palavra, sem mudar nada) que fala deste local. Curto: só a parte que fala dele.
- "reason": em português, até 2 frases curtas, explique o que você identificou e por que marcou este local (ex.: "Ruído ao frear e disco riscado indicam desgaste no freio dianteiro esquerdo.").
- No máximo ${MAX_SPOTS} pontos.

Responda SOMENTE um JSON no formato: {"spots":[{"zone":"id_da_regiao","excerpt":"...","reason":"..."}]}`;

function normalize(text: string) {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Trecho que realmente está na descrição; senão, a frase da descrição mais parecida. */
function groundExcerpt(excerpt: string, description: string): string {
  const clean = excerpt.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  if (clean && normalize(description).includes(normalize(clean))) return clean;
  const sentences = description.split(/(?<=[.!?;\n])\s+/).map((s) => s.trim()).filter(Boolean);
  const words = new Set(normalize(clean).split(" ").filter((w) => w.length > 3));
  let best = sentences[0] ?? description;
  let bestScore = -1;
  for (const sentence of sentences) {
    const score = normalize(sentence).split(" ").filter((w) => words.has(w)).length;
    if (score > bestScore) {
      best = sentence;
      bestScore = score;
    }
  }
  return best;
}

export function parseSpots(content: string, description: string): DiagnosisSpot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const raw = (parsed as { spots?: unknown })?.spots;
  if (!Array.isArray(raw)) return [];
  const byZone = new Map<string, DiagnosisSpot>();
  for (const item of raw.slice(0, MAX_SPOTS * 2)) {
    if (!item || typeof item !== "object") continue;
    const { zone, excerpt, reason } = item as Record<string, unknown>;
    if (typeof zone !== "string" || !VEHICLE_ZONES[zone]) continue;
    const z = VEHICLE_ZONES[zone];
    const text = groundExcerpt(typeof excerpt === "string" ? excerpt : "", description).slice(0, 400);
    const why = (typeof reason === "string" ? reason.trim() : "").slice(0, 300);
    const existing = byZone.get(zone);
    if (existing) {
      // Mesma região citada duas vezes: junta num ponto só.
      if (!normalize(existing.excerpt).includes(normalize(text))) existing.excerpt = `${existing.excerpt} … ${text}`.slice(0, 600);
      continue;
    }
    byZone.set(zone, { zone, label: z.label, x: z.x, y: z.y, excerpt: text, reason: why });
    if (byZone.size >= MAX_SPOTS) break;
  }
  return [...byZone.values()];
}

/**
 * Pede à IA os pontos do diagnóstico. Nunca lança erro: sem OPENAI_API_KEY, com a IA fora
 * do ar ou resposta ilegível, devolve [] (o diagnóstico é salvo do mesmo jeito e o site
 * mostra um ponto geral com a descrição inteira).
 */
export async function analyzeDiagnosisSpots(input: {
  service: string;
  description: string;
  vehicle?: string;
}): Promise<DiagnosisSpot[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !input.description.trim()) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1200,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `${input.vehicle ? `VEÍCULO: ${input.vehicle}\n` : ""}SERVIÇO: ${input.service}\nDESCRIÇÃO DO DIAGNÓSTICO:\n${input.description}`,
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`[diagnóstico IA] OpenAI respondeu ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return [];
    }
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return parseSpots(json.choices?.[0]?.message?.content ?? "", input.description);
  } catch (err) {
    console.error("[diagnóstico IA] falha ao analisar a descrição:", (err as Error).message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
