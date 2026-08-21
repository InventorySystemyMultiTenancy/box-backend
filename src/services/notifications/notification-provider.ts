// Contrato para envio de SMS/WhatsApp. Um provider real (Twilio, Zenvia, Meta Cloud API...)
// precisa de credenciais/contrato que este projeto não tem — MockNotificationProvider
// (mock-provider.ts) implementa esta mesma interface só gravando o log, sem enviar de fato.
export interface NotificationInput {
  channel: "SMS" | "WHATSAPP";
  to: string;
  message: string;
}

export interface NotificationProvider {
  readonly name: string;
  send(input: NotificationInput): Promise<void>;
}
