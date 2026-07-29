import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Popula o mesmo cenário usado na especificação de experiência (Civic 2021,
// OS-2026-04471, troca de bomba d'água + pastilhas) para o dashboard já
// nascer demonstrável, sem tela vazia.
async function main() {
  console.log("Seed: limpando dados existentes...");
  await prisma.quoteRequest.deleteMany();
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

  // Cliente sem nenhuma ordem em andamento — demonstra o fluxo de "solicitar orçamento".
  const customerNoOrder = await prisma.user.create({
    data: {
      name: "Fernanda R.",
      email: "cliente2@box.demo",
      passwordHash: customerPassword,
      role: "CUSTOMER",
      phone: "+55 11 90000-0001",
    },
  });

  // Cliente com uma solicitação de orçamento pendente — demonstra a fila do mecânico.
  const customerWithRequest = await prisma.user.create({
    data: {
      name: "Carlos E.",
      email: "cliente3@box.demo",
      passwordHash: customerPassword,
      role: "CUSTOMER",
      phone: "+55 11 90000-0002",
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
    ],
  });

  // Peças com criadas via create() (não createMany) para termos o id e linkar a aprovação —
  // é o mesmo caminho usado pelo endpoint /parts/problems em produção.
  const freios = await prisma.vehiclePart.create({
    data: {
      serviceOrderId: order.id,
      key: "freios",
      name: "Freios dianteiros",
      status: "WARNING",
      note: "Identificado desgaste de 70% nas pastilhas dianteiras. Fotos anexadas ao laudo — aguardando aprovação para troca.",
      wearLevel: 70,
      responsibleId: mechanic.id,
    },
  });

  const suspensao = await prisma.vehiclePart.create({
    data: {
      serviceOrderId: order.id,
      key: "suspensao",
      name: "Suspensão traseira",
      status: "CRITICAL",
      note: "Amortecedor traseiro direito com vazamento de óleo visível. Recomendação: substituição do par para manter equilíbrio de rodagem.",
      wearLevel: 85,
      responsibleId: mechanic.id,
    },
  });

  const approval = await prisma.approval.create({
    data: {
      serviceOrderId: order.id,
      partId: freios.id,
      title: "Novo problema encontrado",
      description: "Desgaste de 70% nas pastilhas dianteiras. Fotos anexadas. Requer sua aprovação para prosseguir.",
      estimatedValue: 420,
      status: "PENDING",
    },
  });

  await prisma.approval.create({
    data: {
      serviceOrderId: order.id,
      partId: suspensao.id,
      title: "Novo problema encontrado",
      description: "Vazamento de óleo no amortecedor traseiro direito. Recomendação: substituição do par.",
      estimatedValue: 680,
      status: "PENDING",
    },
  });

  const quoteRequest = await prisma.quoteRequest.create({
    data: {
      customer: { connect: { id: customerWithRequest.id } },
      problemDescription: "Suspensão fazendo barulho ao passar em buracos e lombadas, principalmente do lado direito.",
      preferredDates: "Segunda ou quarta-feira pela manhã",
      vehicle: {
        create: {
          owner: { connect: { id: customerWithRequest.id } },
          brand: "Hyundai",
          model: "HB20",
          year: 2019,
          engine: "1.0",
          plate: "XYZ-9F88",
          mileage: 71500,
        },
      },
    },
  });

  console.log("Seed concluído:");
  console.log(`  Cliente: cliente@box.demo / cliente123 (com ordem em andamento)`);
  console.log(`  Cliente: cliente2@box.demo / cliente123 (sem ordens — testa "solicitar orçamento")`);
  console.log(`  Cliente: cliente3@box.demo / cliente123 (com solicitação de orçamento pendente)`);
  console.log(`  Mecânico: diego@box.demo / mecanico123`);
  console.log(`  Ordem de serviço: ${order.code} (id ${order.id})`);
  console.log(`  Aprovação pendente: ${approval.id}`);
  console.log(`  Solicitação de orçamento pendente: ${quoteRequest.id}`);
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
