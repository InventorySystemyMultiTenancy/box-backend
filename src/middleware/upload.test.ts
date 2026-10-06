import { describe, expect, it } from "vitest";
import { isAllowedUpload } from "@/middleware/upload";

describe("isAllowedUpload", () => {
  it("aceita foto, vídeo, áudio e PDF", () => {
    expect(isAllowedUpload("image/jpeg", "painel.jpg")).toBe(true);
    expect(isAllowedUpload("video/mp4", "diagnostico.mp4")).toBe(true);
    expect(isAllowedUpload("audio/webm", "pergunta.webm")).toBe(true);
    expect(isAllowedUpload("application/pdf", "nota.pdf")).toBe(true);
  });

  it("recusa SVG, HTML e executáveis", () => {
    expect(isAllowedUpload("image/svg+xml", "logo.svg")).toBe(false);
    expect(isAllowedUpload("text/html", "pagina.html")).toBe(false);
    expect(isAllowedUpload("application/x-msdownload", "programa.exe")).toBe(false);
  });

  it("recusa extensão perigosa mesmo com mimetype de imagem", () => {
    expect(isAllowedUpload("image/png", "truque.html")).toBe(false);
    expect(isAllowedUpload("image/png", "truque.svg")).toBe(false);
  });
});
