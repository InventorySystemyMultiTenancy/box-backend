import fs from "fs";

export class SpeechToTextError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

// Mesmo provedor de IA já usado em toda leitura de imagem do sistema (OPENAI_API_KEY) —
// aqui só troca o endpoint (transcrição de áudio) e o formato de envio (multipart, não
// JSON), reaproveitado pelo botão de microfone da busca/chat de ajuda.
export async function transcribeAudio(filePath: string, mimetype: string, originalName: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SpeechToTextError("Transcrição por IA não configurada (defina OPENAI_API_KEY no ambiente).", 501);
  }

  const buffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype }), originalName || "audio.webm");
  form.append("model", "whisper-1");
  form.append("language", "pt");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new SpeechToTextError(`Falha ao transcrever o áudio (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { text?: string };
  const text = json.text?.trim();
  if (!text) throw new SpeechToTextError("Não consegui entender o áudio — tente falar de novo.", 502);
  return text;
}
