// Motor do Agente Apta: chamado quando chega mensagem numa conversa em modo
// AGENTE. Usa a API do Gemini (Google) com as instruções cadastradas no
// AgenteIA como contexto fixo, mais o histórico recente da conversa. Se o
// Gemini falhar ou a chave não estiver configurada, a conversa volta sozinha
// para o modo HUMANO em vez de ficar "presa" sem resposta.
import type { Cliente } from "@prisma/client";
import { linkPublico } from "../envio/mensagem-protocolo.js";
import { prisma } from "../prisma.js";
import { contextoDoLead, executarFerramentaLead, ferramentasDoLead, type Ferramenta } from "../leads/ferramentas.js";
import { ENCERRADOS, avisarEquipe } from "../leads/leads.js";
import { enviarMensagem, registrarSistema } from "./conversas.js";

// Quantas mensagens recentes (cliente + agente/atendente) entram no contexto
// mandado pro Gemini a cada resposta.
const HISTORICO_MAX = 20;

// Config do banco (tela "Agentes e IA") tem prioridade; GEMINI_API_KEY/
// GEMINI_MODEL no ambiente servem de valor padrão enquanto ninguém configurar
// pela tela.
async function configGemini() {
  const config = await prisma.configuracaoGemini.findUnique({ where: { id: 1 } });
  return {
    apiKey: config?.apiKey || process.env.GEMINI_API_KEY || null,
    modelo: config?.modelo || process.env.GEMINI_MODEL || "gemini-flash-latest",
  };
}

export async function motorAgenteConfigurado(): Promise<boolean> {
  return Boolean((await configGemini()).apiKey);
}

interface ParteGemini {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

interface ConteudoGemini {
  role: "user" | "model";
  parts: ParteGemini[];
}

// Única ferramenta do agente por enquanto: buscar e mandar a declaração
// (guia) mais recente já concluída do cliente da conversa. Só é oferecida ao
// Gemini quando a conversa já está vinculada a um cliente (ver acionarAgente).
const FERRAMENTA_DECLARACAO = {
  name: "enviar_declaracao",
  description:
    "Busca a declaração/guia mais recente já concluída do cliente desta conversa e devolve o link de entrega real, pra você passar pro cliente. Use sempre que o cliente pedir a declaração, a guia ou o documento dele.",
  parameters: { type: "OBJECT", properties: {}, required: [] },
};

// Nunca deixa o Gemini escolher livremente qual cliente/documento: a busca é
// sempre presa ao cliente já identificado pelo telefone da conversa.
async function buscarDeclaracaoParaEnvio(clienteId: string): Promise<Record<string, unknown>> {
  const obrigacao = await prisma.obrigacao.findFirst({
    where: {
      clienteId,
      nome: { contains: "declara", mode: "insensitive" },
      concluidaEm: { not: null },
    },
    orderBy: { competencia: "desc" },
    include: { protocolos: { orderBy: { numero: "desc" }, take: 1 } },
  });

  if (!obrigacao) {
    return { encontrada: false, motivo: "Nenhuma declaração concluída encontrada para este cliente." };
  }
  const protocolo = obrigacao.protocolos[0];
  if (!protocolo) {
    return {
      encontrada: false,
      motivo: "A declaração existe mas ainda não tem link de entrega gerado; oriente o cliente a falar com um atendente.",
    };
  }
  return {
    encontrada: true,
    nomeDocumento: obrigacao.nome,
    competencia: obrigacao.competencia ? obrigacao.competencia.toISOString().slice(0, 7) : null,
    link: linkPublico(protocolo.token),
  };
}

// Bloco de contexto montado na hora, antes das instruções cadastradas no
// AgenteIA (que cuidam de tom/serviços) — é isso que "modula" a conversa pelo
// cadastro do cliente.
function contextoCliente(cliente: Cliente | null): string {
  if (!cliente) {
    return [
      "DADOS DO CONTATO: este número de WhatsApp NÃO está cadastrado na base de clientes da Apta.",
      "Apresente a Apta Contabilidade e os serviços oferecidos normalmente.",
      "NÃO ofereça fazer o cadastro por aqui — cadastro de cliente novo é feito só por um atendente humano.",
      "Você não tem acesso a nenhuma ferramenta de buscar/enviar documento nesta conversa. Se pedirem declaração/guia, explique que esse serviço é exclusivo para clientes já cadastrados e ofereça transferir para um atendente humano caso a pessoa queira virar cliente.",
    ].join(" ");
  }
  return [
    `DADOS DO CONTATO: este número é de um cliente cadastrado — ${cliente.razaoSocial}${cliente.apelido ? ` (${cliente.apelido})` : ""}.`,
    cliente.regimeTributario ? `Regime tributário: ${cliente.regimeTributario}.` : "",
    "Cumprimente mencionando que já identificou o cadastro e pergunte como pode ajudar.",
    "Se o cliente pedir a declaração, a guia ou o documento dele, use a ferramenta enviar_declaracao e repasse o link exatamente como ela devolver, sem inventar nem alterar a URL. Se a ferramenta disser que não encontrou, avise o cliente com naturalidade e ofereça transferir para um atendente.",
  ]
    .filter(Boolean)
    .join(" ");
}

type Executor = (nome: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface OpcoesGemini {
  ferramentas: Ferramenta[];
  executar: Executor;
}

// Ferramentas por contexto: conversa de lead usa as de agenda/perfil;
// cliente identificado usa enviar_declaracao; contato desconhecido, nenhuma.
function opcoesCliente(clienteId: string | null): OpcoesGemini {
  if (!clienteId) return { ferramentas: [], executar: async () => ({ erro: "Sem ferramentas nesta conversa" }) };
  return {
    ferramentas: [FERRAMENTA_DECLARACAO],
    executar: async (nome) =>
      nome === "enviar_declaracao" ? buscarDeclaracaoParaEnvio(clienteId) : { erro: `Ferramenta desconhecida: ${nome}` },
  };
}

async function chamarGemini(instrucoes: string, historicoInicial: ConteudoGemini[], opcoes: OpcoesGemini): Promise<string> {
  const { apiKey, modelo } = await configGemini();
  if (!apiKey) {
    throw new Error("Gemini não configurado (tela Agentes e IA ou GEMINI_API_KEY)");
  }

  const ferramentas = opcoes.ferramentas.length ? [{ functionDeclarations: opcoes.ferramentas }] : undefined;
  const nomesPermitidos = new Set(opcoes.ferramentas.map((f) => f.name));
  const contents: ConteudoGemini[] = [...historicoInicial];

  // Até 4 idas e vindas com ferramenta ("consultar horários → reservar" já
  // usa duas); evita loop infinito se o Gemini insistir em chamar de novo.
  const MAX_RODADAS_FERRAMENTA = 4;

  for (let rodada = 0; rodada <= MAX_RODADAS_FERRAMENTA; rodada++) {
    const resposta = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: instrucoes }] },
          contents,
          ...(ferramentas ? { tools: ferramentas } : {}),
        }),
      }
    );
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => "");
      throw new Error(`Gemini respondeu ${resposta.status}: ${corpo.slice(0, 300)}`);
    }
    const dados = (await resposta.json()) as {
      candidates?: { content?: { parts?: ParteGemini[] } }[];
    };
    const parts = dados.candidates?.[0]?.content?.parts ?? [];
    const chamadas = parts.filter((parte) => parte.functionCall).map((parte) => parte.functionCall!);

    if (chamadas.length && rodada < MAX_RODADAS_FERRAMENTA) {
      contents.push({ role: "model", parts });
      const respostas: ParteGemini[] = [];
      for (const chamada of chamadas) {
        const resultado = nomesPermitidos.has(chamada.name)
          ? await opcoes.executar(chamada.name, chamada.args ?? {})
          : { erro: `Ferramenta não disponível: ${chamada.name}` };
        respostas.push({ functionResponse: { name: chamada.name, response: resultado } });
      }
      contents.push({ role: "user", parts: respostas });
      continue;
    }

    const texto = parts
      .map((parte) => parte.text ?? "")
      .join("")
      .trim();
    if (!texto) {
      throw new Error("Gemini não retornou texto na resposta");
    }
    return texto;
  }
  throw new Error("Gemini não finalizou a resposta depois de usar a ferramenta");
}

// O Gemini às vezes responde 503 ("sobrecarregado") por alguns segundos só —
// antes de devolver a conversa pro humano, vale tentar de novo um punhado de
// vezes, com uma pausa curta entre elas.
const TENTATIVAS_GEMINI = 4;
const PAUSA_ENTRE_TENTATIVAS_MS = 4_000;

function aguardar(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chamarGeminiComRetentativas(
  instrucoes: string,
  historico: ConteudoGemini[],
  opcoes: OpcoesGemini
): Promise<string> {
  let ultimoErro: unknown;
  for (let tentativa = 1; tentativa <= TENTATIVAS_GEMINI; tentativa++) {
    try {
      return await chamarGemini(instrucoes, historico, opcoes);
    } catch (error) {
      ultimoErro = error;
      console.warn(
        `[agente] Tentativa ${tentativa}/${TENTATIVAS_GEMINI} falhou: ${error instanceof Error ? error.message : String(error)}`
      );
      if (tentativa < TENTATIVAS_GEMINI) {
        await aguardar(PAUSA_ENTRE_TENTATIVAS_MS);
      }
    }
  }
  throw ultimoErro;
}

async function voltarParaHumano(conversaId: string, motivo: string) {
  console.error(`[agente] Conversa ${conversaId}: ${motivo}`);
  await registrarSistema(conversaId, "O agente de IA não conseguiu responder agora; a conversa voltou para atendimento humano.");
  await prisma.conversa.update({ where: { id: conversaId }, data: { modo: "HUMANO" } });
}

// Uma resposta por vez em cada conversa: se o cliente manda três mensagens
// seguidas, o agente responde uma vez só, olhando todas.
const emAndamento = new Map<string, boolean>();

export async function acionarAgente(conversaId: string): Promise<void> {
  if (emAndamento.has(conversaId)) {
    emAndamento.set(conversaId, true); // roda de novo quando a atual terminar
    return;
  }
  emAndamento.set(conversaId, false);
  try {
    do {
      emAndamento.set(conversaId, false);
      await responderComAgente(conversaId);
    } while (emAndamento.get(conversaId));
  } finally {
    emAndamento.delete(conversaId);
  }
}

// Junta mensagens seguidas do mesmo lado (o Gemini espera usuário/modelo
// alternados) e garante que a conversa começa pelo usuário.
function alternar(mensagens: ConteudoGemini[]): ConteudoGemini[] {
  const saida: ConteudoGemini[] = [];
  for (const m of mensagens) {
    const ultima = saida.at(-1);
    if (ultima && ultima.role === m.role) ultima.parts.push(...m.parts);
    else saida.push({ role: m.role, parts: [...m.parts] });
  }
  if (saida[0]?.role === "model") saida.unshift({ role: "user", parts: [{ text: "(Conversa iniciada pela Apta.)" }] });
  return saida;
}

async function responderComAgente(conversaId: string): Promise<void> {
  if (!(await motorAgenteConfigurado())) {
    console.log(`[agente] Conversa ${conversaId} em modo agente, mas o motor ainda não está configurado.`);
    return;
  }

  const conversa = await prisma.conversa.findUnique({
    where: { id: conversaId },
    include: { agente: true, cliente: true, lead: true },
  });
  if (!conversa || conversa.modo !== "AGENTE" || !conversa.agente) {
    return;
  }
  if (!conversa.agente.ativo) {
    await voltarParaHumano(conversaId, `agente "${conversa.agente.nome}" está desativado`);
    return;
  }
  const lead = conversa.lead && !ENCERRADOS.includes(conversa.lead.status) ? conversa.lead : null;

  // "desc" + take pra pegar as HISTORICO_MAX mais RECENTES (não as mais
  // antigas); depois reverte pra ordem cronológica que a API espera. Na
  // conversa de lead, a primeira mensagem automática também entra.
  const autores = lead ? (["CLIENTE", "AGENTE", "ATENDENTE", "AUTOMACAO"] as const) : (["CLIENTE", "AGENTE", "ATENDENTE"] as const);
  const mensagensRecentes = await prisma.mensagem.findMany({
    where: { conversaId, interna: false, autor: { in: [...autores] } },
    orderBy: { createdAt: "desc" },
    take: HISTORICO_MAX,
    select: { autor: true, texto: true },
  });
  const mensagens = mensagensRecentes.reverse();
  const historico = alternar(
    mensagens
      .filter((mensagem) => mensagem.texto)
      .map((mensagem) => ({
        role: mensagem.autor === "CLIENTE" ? ("user" as const) : ("model" as const),
        parts: [{ text: mensagem.texto! }],
      }))
  );
  // Precisa de mensagem do cliente, e a última tem que ser dele.
  if (!historico.some((m) => m.role === "user" && m.parts.some((p) => p.text !== "(Conversa iniciada pela Apta.)"))) return;
  if (historico.at(-1)?.role !== "user") return;

  const contexto = lead ? await contextoDoLead(lead) : contextoCliente(conversa.cliente);
  const instrucoesFinais = `${contexto}\n\n${conversa.agente.instrucoes}`;
  const opcoes: OpcoesGemini = lead
    ? { ferramentas: ferramentasDoLead(lead), executar: (nome, args) => executarFerramentaLead(lead.id, nome, args) }
    : opcoesCliente(conversa.clienteId);

  try {
    const resposta = await chamarGeminiComRetentativas(instrucoesFinais, historico, opcoes);
    await enviarMensagem({ conversaId, texto: resposta, autor: "AGENTE", agenteId: conversa.agente.id });
  } catch (error) {
    await voltarParaHumano(conversaId, error instanceof Error ? error.message : String(error));
    if (lead) {
      await avisarEquipe(lead, {
        tipo: "lead_precisa_humano",
        titulo: `${lead.nome} ficou sem resposta do assistente`,
        mensagem: "O assistente não conseguiu responder agora e a conversa voltou para a equipe.",
        severidade: "erro",
        href: `/dashboard/atendimento?conversa=${conversaId}`,
        chave: `lead-falha-ia:${lead.id}:${Date.now()}`,
      });
    }
  }
}
