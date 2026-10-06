// Mesmo provider/modelo já usado em truck-vision.service.ts, vehicle-recognition.service.ts
// e invoice-ocr.service.ts — reaproveitado por consistência (só que aqui só texto, sem imagem).
const OPENAI_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";

export class SearchAssistantError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface SearchAssistAction {
  path: string;
  label: string;
}

export interface SearchAssistResult {
  message: string;
  steps: string[] | null;
  suggestedQuery: string | null;
  actions: SearchAssistAction[];
}

export interface SearchAssistTurn {
  role: "user" | "assistant";
  content: string;
}

// Cap de turnos anteriores repassados pra IA — o suficiente pra manter o fio da
// conversa numa pergunta de uso sem deixar o prompt crescer sem limite.
const MAX_HISTORY_TURNS = 12;

// Rotas que a IA pode sugerir — mesma lista de abas do painel (src/app/dashboard/layout.tsx
// no front). Qualquer path que a IA responda fora desta lista é descartado antes de
// devolver ao cliente, pra nunca navegar o usuário para algo inexistente/inválido.
const KNOWN_ROUTES: SearchAssistAction[] = [
  { path: "/dashboard", label: "Projetos" },
  { path: "/dashboard/solicitacoes", label: "Solicitações" },
  { path: "/dashboard/usuarios", label: "Usuários" },
  { path: "/dashboard/pecas", label: "Peças" },
  { path: "/dashboard/financeiro", label: "Financeiro" },
  { path: "/dashboard/clientes", label: "Clientes" },
  { path: "/dashboard/gastos", label: "Gastos" },
  { path: "/dashboard/alertas", label: "Alertas" },
  { path: "/dashboard/caminhoes", label: "Caminhões" },
  { path: "/dashboard/seguradoras", label: "Seguradoras" },
  { path: "/dashboard/fornecedores", label: "Fornecedores" },
  { path: "/dashboard/compras", label: "Compras" },
  { path: "/dashboard/agenda", label: "Agenda" },
  { path: "/dashboard/pdv", label: "PDV" },
  { path: "/dashboard/garantias", label: "Garantias" },
  { path: "/dashboard/relatorios", label: "Relatórios" },
  { path: "/dashboard/comissoes", label: "Comissões" },
  { path: "/dashboard/lojas", label: "Lojas" },
  { path: "/dashboard/cargos", label: "Cargos" },
  { path: "/dashboard/perfil", label: "Perfil" },
];

const SYSTEM_PROMPT = `Você é o assistente de ajuda da BOX., um sistema de gestão de oficina mecânica, incorporado na busca do painel administrativo. Você pode ser acionado de duas formas:

(1) PRIMEIRA MENSAGEM: um funcionário digitou algo na busca global e ela não encontrou nenhum registro (a busca de registros cobre: ordens de serviço, orçamentos, usuários/clientes, veículos, fornecedores, peças, caminhões e seguradoras). Isso pode significar duas coisas:
  (A) A pessoa estava procurando um registro (cliente, OS, placa, peça...) mas digitou errado ou ele não existe.
  (B) A pessoa não está procurando um registro — está PERGUNTANDO como fazer algo no sistema, ou o que é/serve alguma aba, ex: "como cadastrar um cliente", "como avançar etapa", "como emitir nota fiscal", "como gerar relatório", "como funciona o pdv", "o que é essa aba?". Nesse caso é uma pergunta de uso, não uma busca.

(2) MENSAGENS SEGUINTES: se já existem mensagens anteriores nesta conversa (abaixo), a pessoa está continuando o papo — reformulando a pergunta, corrigindo você ("não era isso que eu queria, me ajude com..."), ou pedindo mais detalhes sobre o que você acabou de responder. Trate como uma conversa de verdade: leve em conta o que já foi dito, não recomece do zero nem repita o que já explicou, e ajuste a resposta ao que a pessoa realmente quer agora. Nesses casos considere sempre como pergunta de uso (caso B) — só a primeira mensagem pode ser uma busca de registro (caso A).

Às vezes a pessoa cola a própria URL da página em que está (ex.: ".../dashboard/gastos") junto da pergunta — nesse caso o trecho depois de "/dashboard/" é o path de uma das rotas da lista abaixo; use isso pra saber exatamente de qual aba ela está falando, mesmo sem ela nomear a aba. Toda rota da lista abaixo é uma aba real e existente do sistema — nunca diga que uma delas "não existe".

Se for o caso (B), gere uma resposta curta e objetiva — com um tutorial de 3 a 5 passos quando fizer sentido, na ordem em que a pessoa deve clicar/preencher — usando EXATAMENTE os nomes de botões/campos/abas descritos abaixo — nunca invente um botão ou campo que não está na lista. Aponte a aba certa em "actions". Se for o caso (A), não gere tutorial — só explique/sugira como no comportamento normal.

Responda SEMPRE em português, APENAS com um JSON válido, sem markdown, no formato:
{
  "message": "<1-2 frases curtas: no caso B, uma introdução ao tutorial; no caso A, por que talvez não achou nada>",
  "steps": ["<passo 1>", "<passo 2>", "..."] ou null se não for uma pergunta de uso (caso A),
  "suggestedQuery": "<no caso A, um termo de busca alternativo mais provável de achar algo; null no caso B ou se não houver sugestão melhor>",
  "actions": [{ "path": "<uma das rotas da lista abaixo>", "label": "<label EXATAMENTE como está na lista>" }]
}

"actions" deve ter no máximo 2 itens, só rotas realmente relevantes — nunca invente uma rota fora da lista. Se nada for claramente relevante, devolva "actions": [].

Rotas e o que dá pra fazer em cada uma (path — label — botões/ações reais que existem lá):
- /dashboard — Projetos — kanban das ordens de serviço em andamento, organizado em colunas por etapa. Botão "Novo projeto" (canto superior) abre um formulário único que cadastra cliente novo OU escolhe cliente já existente, cadastra o veículo (marca/modelo/ano/placa) e já cria a ordem de serviço — é o único lugar do sistema onde se cadastra um veículo novo. Pra avançar a etapa de um projeto: arraste o card para a coluna seguinte no kanban, OU clique no card pra abrir o projeto e use a seção "Avançar etapa" dentro dele (permite anexar foto da etapa). "Finalizar projeto"/entrega também fica dentro do projeto aberto.
- /dashboard/solicitacoes — Solicitações — pedidos de orçamento feitos por clientes pelo próprio painel deles, aguardando a oficina aceitar/recusar antes de virar um projeto
- /dashboard/usuarios — Usuários — cadastro de usuários do sistema (mecânicos e admins, define cargo/permissão); clientes se cadastram em Clientes, não aqui
- /dashboard/clientes — Clientes — botão "Novo cliente" cadastra nome/telefone/e-mail; abrir um cliente mostra os veículos e o histórico de ordens de serviço dele (veículo novo só se cadastra pelo fluxo de "Novo projeto")
- /dashboard/pecas — Peças — cadastro de peças e materiais com preço (sem controle de estoque), usadas nos projetos e no PDV
- /dashboard/fornecedores — Fornecedores — botão "Novo fornecedor" cadastra nome/CNPJ/contato
- /dashboard/compras — Compras — botão "Novo pedido de compra" registra itens comprados de um fornecedor (gera a conta a pagar e acompanha o recebimento)
- /dashboard/financeiro — Financeiro — tem sub-abas: "Contas a pagar" (botão "Nova conta a pagar"), "Contas a receber" (botão "Nova conta a receber"), "Contas bancárias" (botão "Nova conta"), "Fluxo de caixa" e "Notas fiscais" (botão "Nova nota fiscal" cadastra a nota; botão "Emitir" na lista de fato emite)
- /dashboard/comissoes — Comissões — comissão dos mecânicos sobre reparos concluídos
- /dashboard/caminhoes — Caminhões — botão "Novo caminhão" cadastra a frota; também controla viagens (início/fim) e abastecimentos
- /dashboard/seguradoras — Seguradoras — botão "Nova seguradora" cadastra seguradora parceira (usada quando a OS é de sinistro)
- /dashboard/agenda — Agenda — botão "Novo agendamento" marca horário/baia pra um veículo; "Novo box/elevador" cadastra uma baia de atendimento
- /dashboard/pdv — PDV — "Nova venda": venda de peça/produto de balcão direto, sem abrir uma ordem de serviço
- /dashboard/garantias — Garantias — lista peças com garantia vencendo ou já vencida
- /dashboard/relatorios — Relatórios — indicadores gerenciais; use os campos de data "De" e "Até" no topo da página pra gerar o relatório do período desejado (atualiza automaticamente, não tem botão separado de "gerar")
- /dashboard/lojas — Lojas — botão "Nova loja" cadastra unidade/filial
- /dashboard/cargos — Cargos — botão "Novo cargo" cadastra cargo e define quais abas/permissões ele enxerga
- /dashboard/gastos — Gastos — "Meus gastos": qualquer mecânico/admin lança aqui um gasto próprio (categoria, descrição, valor, data) e pode gerar um relatório impresso do período; o admin vê e filtra os gastos de toda a equipe em Financeiro (aba "Resumo", seção "Cadastrar gasto")
- /dashboard/alertas — Alertas — notificações do sistema
- /dashboard/perfil — Perfil — dados da própria conta (nome, foto, senha)

Seja direto e útil, como alguém que conhece bem o sistema orientando um colega. Se a pergunta for vaga demais pra saber a qual aba se refere (ex.: "como cadastrar tal coisa" sem dizer o quê), pergunte de volta em "message" em vez de chutar um tutorial, e devolva "steps": null.`;

export async function getSearchAssistance(query: string, currentPath?: string, history: SearchAssistTurn[] = []): Promise<SearchAssistResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new SearchAssistantError("Assistente de IA não configurado (defina OPENAI_API_KEY no ambiente).", 501);
  }

  const isFirstMessage = history.length === 0;

  // Só repassa se bater com uma rota conhecida — currentPath vem do front, mas não custa
  // validar antes de colocar no prompt (evita mandar lixo/injeção pra IA como contexto).
  const currentRoute = currentPath ? KNOWN_ROUTES.find((r) => r.path === currentPath) : undefined;
  const routeHint = currentRoute ? `A pessoa está atualmente na aba "${currentRoute.label}" (${currentRoute.path}). ` : "";
  const userContent = isFirstMessage ? `${routeHint}Texto digitado na busca, sem resultados: "${query}"` : `${routeHint}${query}`;

  // Só os últimos N turnos — o bastante pra manter contexto sem deixar o prompt crescer
  // sem limite numa conversa longa.
  const trimmedHistory = history.slice(-MAX_HISTORY_TURNS);

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      max_tokens: 500,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...trimmedHistory.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new SearchAssistantError(`Falha ao consultar a IA (${res.status}): ${errBody.slice(0, 300)}`, 502);
  }

  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new SearchAssistantError("A IA não retornou uma resposta legível.", 502);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new SearchAssistantError("A IA retornou um formato inesperado.", 502);
  }

  const message = typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : "Não encontramos nada para esse termo.";
  const suggestedQueryRaw = typeof parsed.suggestedQuery === "string" ? parsed.suggestedQuery.trim() : "";
  const suggestedQuery = suggestedQueryRaw && suggestedQueryRaw.toLowerCase() !== query.trim().toLowerCase() ? suggestedQueryRaw : null;

  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : [];
  const steps = rawSteps
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim())
    .slice(0, 6);

  const rawActions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const actions: SearchAssistAction[] = [];
  for (const item of rawActions) {
    if (!item || typeof item !== "object") continue;
    const path = (item as Record<string, unknown>).path;
    const known = KNOWN_ROUTES.find((r) => r.path === path);
    if (known && !actions.some((a) => a.path === known.path)) actions.push(known);
    if (actions.length >= 2) break;
  }

  return { message, steps: steps.length > 0 ? steps : null, suggestedQuery, actions };
}
