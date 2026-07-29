import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Popula o mesmo cenário usado na especificação de experiência (Civic 2021,
// OS-2026-04471, troca de bomba d'água + pastilhas) para o dashboard já
// nascer demonstrável, sem tela vazia.
async function main() {
  console.log("Seed: limpando dados existentes...");
  await prisma.chatMessage.deleteMany();
  await prisma.media.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.vehiclePart.deleteMany();
  await prisma.timelineEvent.deleteMany();
  await prisma.serviceOrder.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.user.deleteMany();

  const customerPassword = await bcrypt.hash("cliente123", 10);
  const mechanicPassword = await bcrypt.hash("mecanico123", 10);

  const customer = await prisma.user.create({
    data: {
      name: "Mateus Cruz",
      email: "cliente@box.demo",
      passwordHash: customerPassword,
      role: "CUSTOMER",
      phone: "+55 11 90000-0000",
    },
  });

  const mechanic = await prisma.user.create({
    data: {
      name: "Diego M.",
      email: "diego@box.demo",
      passwordHash: mechanicPassword,
      role: "MECHANIC",
    },
  });

  const vehicle = await prisma.vehicle.create({
    data: {
      ownerId: customer.id,
      brand: "Honda",
      model: "Civic",
      year: 2021,
      engine: "1.5 Turbo",
      plate: "ABC-1D23",
      mileage: 58240,
    },
  });

  const order = await prisma.serviceOrder.create({
    data: {
      code: "OS-2026-04471",
      vehicleId: vehicle.id,
      status: "IN_PROGRESS",
      progress: 64,
      estimatedMin: 1200,
      estimatedMax: 1800,
      receivedAt: atToday(9, 12),
    },
  });

  await prisma.timelineEvent.createMany({
    data: [
      { serviceOrderId: order.id, title: "Veículo entrou na oficina", description: "Check-in fotográfico de 360° registrado", occurredAt: atToday(9, 12), authorId: mechanic.id },
      { serviceOrderId: order.id, title: "Diagnóstico iniciado", occurredAt: atToday(9, 40), authorId: mechanic.id },
      { serviceOrderId: order.id, title: "Identificado desgaste nas pastilhas dianteiras", description: "Nível de desgaste: 70%", occurredAt: atToday(10, 18), authorId: mechanic.id },
      { serviceOrderId: order.id, title: "Fotos anexadas ao laudo", description: "4 imagens · 1 vídeo de 12s", occurredAt: atToday(10, 32), authorId: mechanic.id },
      { serviceOrderId: order.id, title: "Cliente aprovou orçamento adicional", description: "Assinatura eletrônica registrada", occurredAt: atToday(11, 15), authorId: customer.id },
      { serviceOrderId: order.id, title: "Peças instaladas", description: "Bomba d'água + pastilhas dianteiras", occurredAt: atToday(13, 2), authorId: mechanic.id },
      { serviceOrderId: order.id, title: "Teste de rodagem em andamento", description: "Estimativa de conclusão: 16:30", occurredAt: atToday(15, 20), done: false, authorId: mechanic.id },
    ],
  });

  await prisma.vehiclePart.createMany({
    data: [
      {
        serviceOrderId: order.id,
        key: "motor",
        name: "Motor",
        status: "DONE",
        note: "Troca da bomba d'água — vazamento interno identificado no diagnóstico. Peça removida, nova bomba instalada, teste de estanqueidade realizado sem novas ocorrências.",
        wearLevel: 0,
        responsibleId: mechanic.id,
        warranty: "12 meses",
      },
      {
        serviceOrderId: order.id,
        key: "eletrica",
        name: "Elétrica / Bateria",
        status: "DONE",
        note: "Teste de carga da bateria realizado — capacidade em 92% da nominal, dentro do esperado para a idade do veículo.",
        wearLevel: 8,
        responsibleId: mechanic.id,
      },
      {
        serviceOrderId: order.id,
        key: "arcondicionado",
        name: "Ar-condicionado",
        status: "NOT_INSPECTED",
        note: "Não incluído nesta ordem de serviço. Última recarga de gás há 14 meses — recomendação preventiva registrada.",
      },
      {
        serviceOrderId: order.id,
        key: "transmissao",
        name: "Transmissão",
        status: "NOT_INSPECTED",
        note: "Nenhum sintoma relatado nesta entrada. Próxima inspeção preventiva sugerida aos 65.000km.",
      },
      {
        serviceOrderId: order.id,
        key: "escapamento",
        name: "Escapamento",
        status: "NOT_INSPECTED",
        note: "Sem ruídos relatados. Verificação visual de corrosão incluída no checklist de entrega.",
      },
      {
        serviceOrderId: order.id,
        key: "freios",
        name: "Freios dianteiros",
        status: "WARNING",
        note: "Identificado desgaste de 70% nas pastilhas dianteiras. Fotos anexadas ao laudo — aguardando aprovação para troca.",
        wearLevel: 70,
        responsibleId: mechanic.id,
      },
      {
        serviceOrderId: order.id,
        key: "suspensao",
        name: "Suspensão traseira",
        status: "CRITICAL",
        note: "Amortecedor traseiro direito com vazamento de óleo visível. Recomendação: substituição do par para manter equilíbrio de rodagem.",
        wearLevel: 85,
        responsibleId: mechanic.id,
      },
    ],
  });

  const approval = await prisma.approval.create({
    data: {
      serviceOrderId: order.id,
      title: "Novo problema encontrado",
      description: "Desgaste de 70% nas pastilhas dianteiras. Fotos anexadas. Requer sua aprovação para prosseguir.",
      estimatedValue: 420,
      status: "PENDING",
    },
  });

  console.log("Seed concluído:");
  console.log(`  Cliente: cliente@box.demo / cliente123`);
  console.log(`  Mecânico: diego@box.demo / mecanico123`);
  console.log(`  Ordem de serviço: ${order.code} (id ${order.id})`);
  console.log(`  Aprovação pendente: ${approval.id}`);
}

function atToday(hour: number, minute: number) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
