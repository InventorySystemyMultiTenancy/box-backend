// Consulta de placa em base externa (marca/modelo/versão/ano/cor/combustível/município) —
// confirma o que a IA leu da foto, que só "chuta" marca/modelo pela aparência. Não existe
// consulta pública gratuita de placa no Brasil, então usa um provedor pago:
// API Placas / WDAPI (apiplacas.com.br) — PLATE_API_TOKEN no ambiente. Sem token, a consulta
// é simplesmente pulada e o cadastro segue só com o que a IA leu.

export interface PlateLookupResult {
  plate: string;
  brand: string | null;
  model: string | null;
  version: string | null;
  year: number | null;
  modelYear: number | null;
  color: string | null;
  fuelType: string | null;
  chassi: string | null;
  city: string | null;
  state: string | null;
}

export type PlateLookupStatus = "FOUND" | "NOT_FOUND" | "NOT_CONFIGURED" | "INVALID_PLATE" | "ERROR";

// Antiga (ABC1234) ou Mercosul (ABC1D23).
const PLATE_PATTERN = /^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/;
const DEFAULT_API_URL = "https://wdapi2.com.br/consulta";
const TIMEOUT_MS = 10_000;

/** Placa só com letras/números, em maiúsculas — ou null se não for uma placa válida. */
export function normalizePlate(value: string | null | undefined): string | null {
  const plate = (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  return PLATE_PATTERN.test(plate) ? plate : null;
}

export function isPlateLookupConfigured() {
  return Boolean(process.env.PLATE_API_TOKEN);
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const year = (v: unknown) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
};
// O provedor devolve o chassi mascarado (ex.: "*****12345") — só serve se vier completo.
const fullChassi = (v: unknown) => {
  const value = text(v);
  return value && /^[A-HJ-NPR-Z0-9]{17}$/i.test(value) ? value.toUpperCase() : null;
};

/** Converte a resposta do provedor (campos variam de caixa entre versões) para o nosso formato. */
export function parsePlateLookupResponse(plate: string, body: Record<string, unknown>): PlateLookupResult | null {
  const extra = (body.extra && typeof body.extra === "object" ? body.extra : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = text(body[key]) ?? text(extra[key]);
      if (value) return value;
    }
    return null;
  };

  const brand = pick("MARCA", "marca");
  const model = pick("MODELO", "modelo");
  if (!brand && !model) return null;

  return {
    plate,
    brand,
    model,
    version: pick("VERSAO", "versao", "SUBMODELO", "submodelo"),
    year: year(body.ano ?? body.ANO ?? extra.ano_fabricacao),
    modelYear: year(body.anoModelo ?? body.ANOMODELO ?? extra.ano_modelo),
    color: pick("cor", "COR"),
    fuelType: pick("combustivel", "COMBUSTIVEL"),
    chassi: fullChassi(body.chassi ?? extra.chassi),
    city: pick("municipio", "MUNICIPIO"),
    state: pick("uf", "UF"),
  };
}

export async function lookupPlate(rawPlate: string | null | undefined): Promise<{ status: PlateLookupStatus; result: PlateLookupResult | null }> {
  const plate = normalizePlate(rawPlate);
  if (!plate) return { status: "INVALID_PLATE", result: null };

  const token = process.env.PLATE_API_TOKEN;
  if (!token) return { status: "NOT_CONFIGURED", result: null };

  const baseUrl = (process.env.PLATE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/${plate}/${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { status: "NOT_FOUND", result: null };
    if (!res.ok) {
      console.error(`Consulta de placa falhou (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return { status: "ERROR", result: null };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const result = parsePlateLookupResponse(plate, body);
    return result ? { status: "FOUND", result } : { status: "NOT_FOUND", result: null };
  } catch (err) {
    console.error("Consulta de placa falhou", err);
    return { status: "ERROR", result: null };
  }
}
