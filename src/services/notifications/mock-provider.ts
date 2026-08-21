import { NotificationInput, NotificationProvider } from "@/services/notifications/notification-provider";

// Provider padrão em dev/sem contrato com operadora — só loga, não envia de verdade.
export class MockNotificationProvider implements NotificationProvider {
  readonly name = "MOCK";

  async send(input: NotificationInput): Promise<void> {
    console.log(`[notifications:mock] ${input.channel} -> ${input.to}: ${input.message}`);
  }
}
