import { describe, expect, it } from "vitest";
import { parseSpots, VEHICLE_ZONES } from "./diagnosis-spots.service";

const DESCRIPTION =
  "Pastilhas de freio dianteiras gastas, disco esquerdo riscado. Vazamento de óleo no motor pela junta do cabeçote. Lanterna traseira direita quebrada.";

describe("parseSpots (resposta da IA do diagnóstico)", () => {
  it("mantém só regiões conhecidas e coloca a bolinha nas coordenadas da região", () => {
    const spots = parseSpots(
      JSON.stringify({
        spots: [
          { zone: "roda_dianteira_esquerda", excerpt: "disco esquerdo riscado", reason: "Disco riscado no lado esquerdo." },
          { zone: "motor", excerpt: "Vazamento de óleo no motor pela junta do cabeçote", reason: "Junta do cabeçote." },
          { zone: "zona_inventada", excerpt: "x", reason: "y" },
        ],
      }),
      DESCRIPTION
    );
    expect(spots.map((s) => s.zone)).toEqual(["roda_dianteira_esquerda", "motor"]);
    expect(spots[1]).toMatchObject({ x: VEHICLE_ZONES.motor.x, y: VEHICLE_ZONES.motor.y, label: "Motor" });
  });

  it("trecho que não está na descrição vira a frase mais parecida da descrição", () => {
    const [spot] = parseSpots(
      JSON.stringify({ spots: [{ zone: "lanterna_direita", excerpt: "lanterna direita está quebrada", reason: "Lanterna." }] }),
      DESCRIPTION
    );
    expect(spot.excerpt).toBe("Lanterna traseira direita quebrada.");
  });

  it("mesma região duas vezes vira um ponto só", () => {
    const spots = parseSpots(
      JSON.stringify({
        spots: [
          { zone: "motor", excerpt: "Vazamento de óleo no motor", reason: "a" },
          { zone: "motor", excerpt: "junta do cabeçote", reason: "b" },
        ],
      }),
      DESCRIPTION
    );
    expect(spots).toHaveLength(1);
  });

  it("resposta ilegível não quebra: nenhum ponto", () => {
    expect(parseSpots("isto não é json", DESCRIPTION)).toEqual([]);
    expect(parseSpots(JSON.stringify({ outra: 1 }), DESCRIPTION)).toEqual([]);
  });
});
