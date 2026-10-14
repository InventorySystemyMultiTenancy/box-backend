// Formatos de imagem que a IA de visão (OpenAI) aceita. Foto em HEIC/HEIF (iPhone e vários
// Android) ou sem tipo é recusada por ela com um erro genérico — melhor avisar antes, com o
// que fazer. O frontend já converte para JPEG quando o aparelho consegue abrir a foto.
const AI_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export const UNSUPPORTED_AI_IMAGE_MESSAGE =
  "Formato de foto não suportado (ex.: HEIC). Tire a foto pelo botão \"Tirar foto\" ou ajuste a câmera do celular para salvar em JPEG.";

export function isAiSupportedImage(mimetype: string) {
  return AI_IMAGE_TYPES.has(mimetype.toLowerCase());
}
