import { describe, expect, it } from "vitest";
import { clientMessage, FOOTER, normalizePhone, normalizeReply, parseNotifyNumbers, phoneKey, senderPhone, teamMessage } from "@/services/whatsapp.service";

const order = { code: "OS-2026-00012", ssNumber: "SS123A", vehicle: { brand: "Volvo", model: "FH 540", plate: "ABC1D23" } };

describe("telefone", () => {
  it("normaliza para 55 + DDD + número", () => {
    expect(normalizePhone("(11) 99999-8888")).toBe("5511999998888");
    expect(normalizePhone("+55 11 3333-4444")).toBe("551133334444");
    expect(normalizePhone("123")).toBeNull();
  });

  it("chave igual com ou sem o 9º dígito", () => {
    expect(phoneKey("11999998888")).toBe(phoneKey("1199998888"));
  });
});

describe("números da equipe", () => {
  it("lê nome:número separados por vírgula e ignora inválidos", () => {
    expect(parseNotifyNumbers("Tania:11999998888, Luiz:5511988887777,lixo")).toEqual([
      { name: "Tania", phone: "5511999998888" },
      { name: "Luiz", phone: "5511988887777" },
    ]);
    expect(parseNotifyNumbers("11999998888")).toEqual([{ name: null, phone: "5511999998888" }]);
    expect(parseNotifyNumbers(undefined)).toEqual([]);
  });
});

describe("mensagens", () => {
  it("equipe recebe veículo, projeto, SS e link", () => {
    const text = teamMessage(order, "Tania", "https://box/acompanhar/x");
    expect(text).toContain("Olá, Tania!");
    expect(text).toContain("*Volvo FH 540 (ABC1D23)*");
    expect(text).toContain("OS-2026-00012 · SS SS123A");
    expect(text).toContain("https://box/acompanhar/x");
    expect(text.endsWith(FOOTER)).toBe(true);
  });

  it("cliente é chamado pelo primeiro nome", () => {
    const text = clientMessage(order, "JOÃO da silva", "https://box/acompanhar/x");
    expect(text).toContain("Olá, João!");
    expect(text).toContain("está pronto");
    expect(text.endsWith(FOOTER)).toBe(true);
  });
});

describe("respostas", () => {
  it("normaliza acentos e pontuação", () => {
    expect(normalizeReply("Não quero mais!")).toBe("NAO QUERO MAIS");
    expect(normalizeReply(" sair ")).toBe("SAIR");
  });

  it("acha o número de quem respondeu, pulando @lid", () => {
    expect(senderPhone({ key: { remoteJid: "123@lid", remoteJidAlt: "5511999998888@s.whatsapp.net" } })).toBe("5511999998888");
  });
});
