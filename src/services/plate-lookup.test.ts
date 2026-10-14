import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupPlate, normalizePlate, parsePlateLookupResponse } from "./plate-lookup.service";

describe("normalizePlate", () => {
  it("aceita placa antiga e Mercosul, com ou sem traço/espaço", () => {
    expect(normalizePlate("abc-1234")).toBe("ABC1234");
    expect(normalizePlate(" ABC 1D23 ")).toBe("ABC1D23");
  });

  it("recusa o que não é placa", () => {
    expect(normalizePlate("AB1234")).toBeNull();
    expect(normalizePlate("1234ABC")).toBeNull();
    expect(normalizePlate(null)).toBeNull();
  });
});

describe("parsePlateLookupResponse", () => {
  it("lê os campos do provedor, inclusive os de dentro de extra", () => {
    const result = parsePlateLookupResponse("ABC1D23", {
      MARCA: "VW",
      MODELO: "GOL 1.0",
      VERSAO: "TRENDLINE",
      ano: "2015",
      anoModelo: "2016",
      cor: "Branca",
      municipio: "São Paulo",
      uf: "SP",
      chassi: "*****12345",
      extra: { combustivel: "Alcool/Gasolina" },
    });
    expect(result).toEqual({
      plate: "ABC1D23",
      brand: "VW",
      model: "GOL 1.0",
      version: "TRENDLINE",
      year: 2015,
      modelYear: 2016,
      color: "Branca",
      fuelType: "Alcool/Gasolina",
      chassi: null,
      city: "São Paulo",
      state: "SP",
    });
  });

  it("sem marca nem modelo, trata como não encontrada", () => {
    expect(parsePlateLookupResponse("ABC1234", { mensagemRetorno: "Sem dados" })).toBeNull();
  });
});

describe("lookupPlate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sem token configurado não chama o provedor", async () => {
    vi.stubEnv("PLATE_API_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await lookupPlate("ABC1234")).toEqual({ status: "NOT_CONFIGURED", result: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consulta o provedor com a placa normalizada", async () => {
    vi.stubEnv("PLATE_API_TOKEN", "tok");
    vi.stubEnv("PLATE_API_URL", "https://exemplo.test/consulta/");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ MARCA: "FIAT", MODELO: "ARGO" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { status, result } = await lookupPlate("abc-1d23");
    expect(fetchMock.mock.calls[0][0]).toBe("https://exemplo.test/consulta/ABC1D23/tok");
    expect(status).toBe("FOUND");
    expect(result?.brand).toBe("FIAT");
  });
});
