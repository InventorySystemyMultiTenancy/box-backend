# BOX. — Backend

API + realtime da plataforma de acompanhamento de manutenção. Implementa o domínio descrito em
`especificacao-experiencia-digital.html`: autenticação, veículos, ordens de serviço, timeline,
peças/componentes, aprovações digitais, chat e upload de mídia — com push em tempo real via Socket.io.

Deploy alvo: **Render**.

## Stack

- Node.js + TypeScript + Express 5
- Prisma ORM — SQLite em desenvolvimento, Postgres em produção
- Socket.io para eventos em tempo real (timeline, status, peças, aprovações, chat)
- JWT (jsonwebtoken + bcryptjs) para autenticação
- Multer para upload de fotos/vídeos/áudios

## Como rodar localmente

```bash
npm install
cp .env.example .env      # já vem com um SQLite local, não precisa editar nada para começar
npm run prisma:migrate    # cria o banco (prisma/dev.db) e aplica o schema
npm run seed               # popula um cenário de demonstração completo
npm run dev                 # sobe em http://localhost:4000
```

Contas criadas pelo seed:

| Papel     | E-mail             | Senha        |
|-----------|--------------------|--------------|
| Cliente   | cliente@box.demo   | cliente123   |
| Mecânico  | diego@box.demo     | mecanico123  |

## Scripts

- `npm run dev` — servidor com reload automático
- `npm run build` / `npm start` — build de produção e execução
- `npm run prisma:migrate` — cria/atualiza o schema do banco
- `npm run prisma:studio` — inspeciona os dados em uma UI
- `npm run seed` — repopula os dados de demonstração

## Migrando de SQLite para Postgres (Render)

1. Crie um banco Postgres no Render (ou Neon) e copie a connection string.
2. Em `prisma/schema.prisma`, troque `provider = "sqlite"` por `provider = "postgresql"`.
3. Defina `DATABASE_URL` no ambiente do Render com a connection string.
4. Rode `npx prisma migrate deploy` no primeiro deploy.

## Estrutura

```
src/
  app.ts              # montagem do Express e das rotas
  server.ts           # HTTP server + bootstrap do Socket.io
  lib/                # prisma client, jwt, constantes de domínio, autorização
  middleware/          # auth (JWT), upload (multer)
  routes/              # auth, vehicles, service-orders, timeline, parts, approvals, chat, uploads
  sockets/              # gateway Socket.io (join-order, emitToOrder)
prisma/
  schema.prisma
  seed.ts
```

## Modelo de dados (visão geral)

`User` → `Vehicle` → `ServiceOrder` → (`TimelineEvent`, `VehiclePart`, `Approval`, `Media`, `ChatMessage`)

Os 11 status de `ServiceOrder` e os status de `VehiclePart` estão centralizados em
`src/lib/constants.ts` — é a fonte da verdade que o frontend espelha.

## Tempo real

O cliente conecta ao Socket.io e emite `join-order` com `{ orderId, token }`. O servidor valida o
token e a posse do veículo antes de inscrever o socket na sala `order:<id>`. Eventos emitidos:
`status:update`, `timeline:new`, `part:update`, `approval:new`, `approval:update`, `chat:message`,
`media:new`.
