import "dotenv/config";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Popula o mesmo cenário usado na especificação de experiência (Civic 2021,
// OS-2026-04471, troca de bomba d'água + pastilhas) para o dashboard já
// nascer demonstrável, sem tela vazia.
async function main() {
  console.log("Seed: limpando dados existentes...");
  await prisma.commission.deleteMany();
  await prisma.store.deleteMany();
  await prisma.appointment.deleteMany();
  await prisma.bay.deleteMany();
  await prisma.counterSale.deleteMany();
  await prisma.purchaseOrderItem.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.accountReceivable.deleteMany();
  await prisma.accountPayable.deleteMany();
  await prisma.bankAccount.deleteMany();
  await prisma.financialEntry.deleteMany();
  await prisma.problemPartUsage.deleteMany();
  await prisma.inventoryPart.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.quoteRequest.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.media.deleteMany();
  await prisma.approval.deleteMany();
  await prisma.vehiclePart.deleteMany();
  await prisma.timelineEvent.deleteMany();
  await prisma.serviceOrder.deleteMany();
  await prisma.vehicle.deleteMany();
  await prisma.client.deleteMany();
  await prisma.userPermission.deleteMany();
  await prisma.user.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.role.deleteMany();

  console.log("Seed: cargos e permissões...");
  const permissionsCatalog = [
    { resource: "clients", action: "view" },
    { resource: "clients", action: "create" },
    { resource: "clients", action: "edit" },
    { resource: "clients", action: "delete" },
    { resource: "roles", action: "view" },
    { resource: "roles", action: "manage" },
    { resource: "finance", action: "view" },
    { resource: "finance", action: "manage" },
    { resource: "invoices", action: "view" },
    { resource: "invoices", action: "manage" },
    { resource: "suppliers", action: "view" },
    { resource: "suppliers", action: "manage" },
    { resource: "purchases", action: "view" },
    { resource: "purchases", action: "manage" },
    { resource: "agenda", action: "view" },
    { resource: "agenda", action: "manage" },
    { resource: "pdv", action: "view" },
    { resource: "pdv", action: "manage" },
    { resource: "reports", action: "view" },
    { resource: "warranties", action: "view" },
    { resource: "warranties", action: "manage" },
    { resource: "commissions", action: "view" },
    { resource: "commissions", action: "manage" },
    { resource: "stores", action: "view" },
    { resource: "stores", action: "manage" },
  ];
  const permissions = await Promise.all(
    permissionsCatalog.map((p) => prisma.permission.create({ data: p }))
  );
  const permissionByKey = (resource: string, action: string) =>
    permissions.find((p) => p.resource === resource && p.action === action)!.id;

  const adminRole = await prisma.role.create({
    data: { name: "Administrador", slug: "admin", isSystem: true },
  });
  const mechanicRole = await prisma.role.create({
    data: { name: "Mecânico", slug: "mecanico", isSystem: true },
  });

  await prisma.rolePermission.createMany({
    data: permissions.map((p) => ({ roleId: adminRole.id, permissionId: p.id })),
  });
  await prisma.rolePermission.createMany({
    data: [
      { roleId: mechanicRole.id, permissionId: permissionByKey("clients", "view") },
      { roleId: mechanicRole.id, permissionId: permissionByKey("agenda", "view") },
      { roleId: mechanicRole.id, permissionId: permissionByKey("warranties", "manage") },
    ],
  });

  const customerPassword = await bcrypt.hash("cliente123", 10);
  const mechanicPassword = await bcrypt.hash("mecanico123", 10);
  const adminPassword = await bcrypt.hash("admin123", 10);

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
      roleId: mechanicRole.id,
      commissionRate: 0.1,
    },
  });

  await prisma.user.create({
    data: {
      name: "Admin BOX",
      email: "admin@box.demo",
      passwordHash: adminPassword,
      role: "ADMIN",
      roleId: adminRole.id,
    },
  });

  console.log("Seed: fornecedores...");
  const supplier = await prisma.supplier.create({
    data: {
      name: "AutoPeças SP Ltda",
      cpfCnpj: "12.345.678/0001-90",
      contactName: "Roberto Lima",
      phone: "+55 11 4000-0000",
      email: "vendas@autopecassp.demo",
      city: "São Paulo",
      state: "SP",
    },
  });

  await prisma.inventoryPart.createMany({
    data: [
      { name: "Disco de freio dianteiro", sku: "FREIO-DISCO-D", unitCost: 180, stockQty: 8, minStockQty: 4, reorderQty: 10, preferredSupplierId: supplier.id },
      { name: "Bobina de ignição", sku: "IGN-BOBINA", unitCost: 145, stockQty: 6, minStockQty: 3, reorderQty: 8, preferredSupplierId: supplier.id },
      // Abaixo do ponto mínimo de propósito — demonstra a sugestão de reposição.
      { name: "Pastilha de freio", sku: "FREIO-PAST", unitCost: 90, stockQty: 2, minStockQty: 5, reorderQty: 15, preferredSupplierId: supplier.id },
    ],
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

  console.log("Seed: backfill de clientes (CRM)...");
  await prisma.client.createMany({
    data: [
      { userId: customer.id, name: customer.name, email: customer.email, phone: customer.phone },
      { userId: customerNoOrder.id, name: customerNoOrder.name, email: customerNoOrder.email, phone: customerNoOrder.phone },
      { userId: customerWithRequest.id, name: customerWithRequest.name, email: customerWithRequest.email, phone: customerWithRequest.phone },
    ],
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
        warrantyMonths: 12,
        warrantyStartAt: monthsAgo(11),
        warrantyExpiresAt: futureDate(30),
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

  console.log("Seed: financeiro e fiscal...");
  const mainAccount = await prisma.bankAccount.create({
    data: { name: "Caixa principal", bank: "Nubank PJ", initialBalance: 5000 },
  });

  const orderClient = await prisma.client.findUnique({ where: { userId: customer.id } });

  await prisma.accountPayable.create({
    data: {
      description: "Compra de peças — distribuidor AutoPeças SP",
      category: "FORNECEDOR",
      payeeName: "AutoPeças SP Ltda",
      amount: 1200,
      dueDate: atToday(0, 0),
      status: "PAID",
      paidAt: atToday(8, 0),
      paidAmount: 1200,
      bankAccountId: mainAccount.id,
      paymentMethod: "PIX",
    },
  });
  await prisma.accountPayable.create({
    data: {
      description: "Aluguel do galpão",
      category: "ALUGUEL",
      payeeName: "Imobiliária Central",
      amount: 3500,
      dueDate: futureDate(10),
    },
  });

  const receivedReceivable = await prisma.accountReceivable.create({
    data: {
      description: `Serviços — OS ${order.code} (sinal)`,
      category: "SERVIÇO",
      clientId: orderClient?.id,
      serviceOrderId: order.id,
      amount: 600,
      dueDate: atToday(0, 0),
      status: "RECEIVED",
      receivedAt: atToday(11, 30),
      receivedAmount: 600,
      bankAccountId: mainAccount.id,
      paymentMethod: "PIX",
    },
  });
  await prisma.accountReceivable.create({
    data: {
      description: `Serviços — OS ${order.code} (saldo na entrega)`,
      category: "SERVIÇO",
      clientId: orderClient?.id,
      serviceOrderId: order.id,
      amount: 600,
      dueDate: futureDate(2),
    },
  });

  await prisma.invoice.create({
    data: {
      type: "NFSE",
      status: "ISSUED",
      number: "000000001",
      series: "1",
      provider: "MOCK",
      providerRef: "seed-demo-ref",
      serviceOrderId: order.id,
      clientId: orderClient?.id,
      accountReceivableId: receivedReceivable.id,
      totalAmount: 600,
      issueDate: atToday(11, 35),
    },
  });

  console.log("Seed: compras...");
  const pastilhaPart = await prisma.inventoryPart.findUnique({ where: { sku: "FREIO-PAST" } });
  const purchaseOrder = await prisma.purchaseOrder.create({
    data: {
      code: "PC-2026-00001",
      supplierId: supplier.id,
      status: "SENT",
      sentAt: atToday(8, 30),
      expectedDate: futureDate(5),
      items: { create: [{ inventoryPartId: pastilhaPart!.id, quantity: 15, unitCost: 90 }] },
    },
  });
  await prisma.accountPayable.create({
    data: {
      description: `Pedido de compra ${purchaseOrder.code} — ${supplier.name}`,
      category: "FORNECEDOR",
      payeeName: supplier.name,
      amount: 15 * 90,
      dueDate: futureDate(5),
      purchaseOrderId: purchaseOrder.id,
      supplierId: supplier.id,
    },
  });

  console.log("Seed: agenda...");
  const lift1 = await prisma.bay.create({ data: { name: "Elevador 1", type: "LIFT" } });
  const bay2 = await prisma.bay.create({ data: { name: "Box 2", type: "BAY" } });

  await prisma.appointment.create({
    data: {
      title: `OS ${order.code} — Civic 2021`,
      vehicleId: vehicle.id,
      clientId: orderClient?.id,
      serviceOrderId: order.id,
      mechanicId: mechanic.id,
      bayId: lift1.id,
      startAt: atToday(9, 0),
      estimatedDurationMin: 240,
      status: "IN_PROGRESS",
      notes: "Troca de bomba d'água + pastilhas dianteiras.",
    },
  });

  const requestClient = await prisma.client.findUnique({ where: { userId: customerWithRequest.id } });
  await prisma.appointment.create({
    data: {
      title: "Revisão preventiva — HB20",
      vehicleId: quoteRequest.vehicleId,
      clientId: requestClient?.id,
      mechanicId: mechanic.id,
      bayId: bay2.id,
      startAt: futureDate(2),
      estimatedDurationMin: 90,
      status: "SCHEDULED",
    },
  });

  console.log("Seed: PDV...");
  const bobinaPart = await prisma.inventoryPart.findUnique({ where: { sku: "IGN-BOBINA" } });
  const counterSaleReceivable = await prisma.accountReceivable.create({
    data: {
      description: "Venda de balcão PDV-2026-00001",
      category: "PDV",
      amount: 145,
      dueDate: atToday(14, 0),
      status: "RECEIVED",
      receivedAt: atToday(14, 0),
      receivedAmount: 145,
      bankAccountId: mainAccount.id,
      paymentMethod: "PIX",
    },
  });
  await prisma.counterSale.create({
    data: {
      code: "PDV-2026-00001",
      customerName: "Cliente balcão",
      paymentMethod: "PIX",
      bankAccountId: mainAccount.id,
      accountReceivableId: counterSaleReceivable.id,
      totalAmount: 145,
      items: { create: [{ inventoryPartId: bobinaPart!.id, quantity: 1, unitPrice: 145 }] },
    },
  });
  await prisma.inventoryPart.update({ where: { id: bobinaPart!.id }, data: { stockQty: { decrement: 1 } } });

  console.log("Seed: lojas e comissões...");
  await prisma.store.create({
    data: { name: "Loja Principal", city: "São Paulo", state: "SP", phone: "+55 11 4000-1000" },
  });

  const demoApproval = await prisma.approval.create({
    data: {
      serviceOrderId: order.id,
      partId: freios.id,
      title: "Troca de amortecedor (demo comissão)",
      description: "Serviço já concluído e aprovado — usado para demonstrar a geração de comissão.",
      estimatedValue: 350,
      status: "APPROVED",
      respondedAt: atToday(12, 0),
    },
  });
  await prisma.commission.create({
    data: {
      mechanicId: mechanic.id,
      approvalId: demoApproval.id,
      serviceOrderId: order.id,
      baseAmount: 350,
      rate: 0.1,
      amount: 35,
      status: "PENDING",
    },
  });

  console.log("Seed concluído:");
  console.log(`  Cliente: cliente@box.demo / cliente123 (com ordem em andamento)`);
  console.log(`  Cliente: cliente2@box.demo / cliente123 (sem ordens — testa "solicitar orçamento")`);
  console.log(`  Cliente: cliente3@box.demo / cliente123 (com solicitação de orçamento pendente)`);
  console.log(`  Mecânico: diego@box.demo / mecanico123`);
  console.log(`  Admin: admin@box.demo / admin123`);
  console.log(`  Ordem de serviço: ${order.code} (id ${order.id})`);
  console.log(`  Aprovação pendente: ${approval.id}`);
  console.log(`  Solicitação de orçamento pendente: ${quoteRequest.id}`);
}

function atToday(hour: number, minute: number) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

function futureDate(daysAhead: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d;
}

function monthsAgo(months: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
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
