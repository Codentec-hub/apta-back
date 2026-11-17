// Ferramentas do Gemini nas conversas de lead e o bloco de contexto que vai
// antes das instruções do agente. As regras de segurança (nunca dizer
// "confirmado", sem links, sem preços) ficam aqui no código, não no texto
// editável.
import type { Agendamento, Lead } from "@prisma/client";
import { prisma } from "../prisma.js";
import { CAMPOS_PERFIL, camposFaltando, perfilCompleto, perfilDe, rotuloDoCampo } from "./campos.js";
import { ConflitoAgenda, descreverHorario, espalhar, horariosLivres, preReservar } from "./agenda.js";
import { configLeads } from "./config.js";
import { avisarEquipe, encerrarLead, passarParaHumano } from "./leads.js";
import { agoraPorExtenso, dataPorExtenso, instanteLocal } from "./tempo.js";

export interface Ferramenta {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const SALVAR_PERFIL: Ferramenta = {
  name: "salvar_perfil",
  description:
    "Grava as respostas que o lead deu sobre a situação dele. Chame sempre que ele responder algo do perfil (pode mandar só os campos novos).",
  parameters: {
    type: "OBJECT",
    properties: Object.fromEntries(CAMPOS_PERFIL.map((c) => [c.chave, { type: "STRING", description: c.rotulo }])),
  },
};

const ENCERRAR_FORA: Ferramenta = {
  name: "encerrar_fora_do_perfil",
  description:
    "Encerra o atendimento quando o lead NÃO é o público da Apta (ver instruções). Depois de chamar, despeça-se com educação numa mensagem curta.",
  parameters: { type: "OBJECT", properties: { motivo: { type: "STRING", description: "Por que não é o perfil" } }, required: ["motivo"] },
};

const SEM_INTERESSE: Ferramenta = {
  name: "lead_sem_interesse",
  description:
    "Use quando o lead disser que não tem interesse, já resolveu com outro escritório ou pedir para não ser mais chamado. Depois, agradeça e despeça-se em uma frase.",
  parameters: { type: "OBJECT", properties: { motivo: { type: "STRING" } }, required: ["motivo"] },
};

const CONSULTAR: Ferramenta = {
  name: "consultar_horarios",
  description:
    "Lista horários livres na agenda da equipe. Use antes de oferecer horários; nunca invente horários. Ofereça no máximo 3 opções por vez, exatamente com o rótulo devolvido.",
  parameters: {
    type: "OBJECT",
    properties: {
      aPartirDe: { type: "STRING", description: "Data AAAA-MM-DD a partir da qual procurar (opcional)" },
      periodo: { type: "STRING", enum: ["manha", "tarde", "noite"], description: "Preferência do lead (opcional)" },
      quantidade: { type: "INTEGER", description: "Quantas opções (padrão 3)" },
    },
  },
};

const RESERVAR: Ferramenta = {
  name: "reservar_horario",
  description:
    "Pré-reserva o horário que o lead escolheu. Passe o campo 'inicio' exatamente como veio de consultar_horarios. O horário fica RESERVADO, não confirmado: a equipe confirma depois.",
  parameters: { type: "OBJECT", properties: { inicio: { type: "STRING", description: "ISO do horário escolhido" } }, required: ["inicio"] },
};

const TRANSFERIR: Ferramenta = {
  name: "transferir_para_humano",
  description:
    "Passa a conversa para a equipe. Use quando o lead pedir para falar com uma pessoa, reclamar, perguntar algo fora do roteiro (preço, caso técnico) ou quiser remarcar um horário já confirmado.",
  parameters: { type: "OBJECT", properties: { motivo: { type: "STRING" } }, required: ["motivo"] },
};

export function ferramentasDoLead(lead: Lead): Ferramenta[] {
  if (lead.status === "AGENDADO") return [TRANSFERIR];
  return [SALVAR_PERFIL, CONSULTAR, RESERVAR, ENCERRAR_FORA, SEM_INTERESSE, TRANSFERIR];
}

async function agendamentoAtivo(leadId: string): Promise<Agendamento | null> {
  return prisma.agendamento.findFirst({
    where: { leadId, status: { in: ["PRE_RESERVADO", "CONFIRMADO"] } },
    orderBy: { inicio: "desc" },
  });
}

export async function contextoDoLead(lead: Lead): Promise<string> {
  const config = await configLeads();
  const perfil = perfilDe(lead.perfil);
  const faltando = camposFaltando(perfil);
  const ativo = await agendamentoAtivo(lead.id);
  const respostas = Object.entries(perfil).map(([k, v]) => `- ${rotuloDoCampo(k)}: ${v}`);

  const linhas = [
    `AGORA: ${agoraPorExtenso()}.`,
    `CONTATO: lead comercial "${lead.nome}", passado por ${config.nomeIndicador}${lead.origem ? ` (origem: ${lead.origem})` : ""}. Você já mandou a primeira mensagem (ou ele chamou primeiro).`,
    lead.observacoes ? `OBSERVAÇÕES DE QUEM CADASTROU: ${lead.observacoes}` : "",
    lead.qualificacao ? `QUALIFICAÇÃO: ${lead.qualificacao}` : "",
    respostas.length
      ? `O QUE JÁ SABEMOS (formulário/conversa — NÃO pergunte de novo, no máximo confirme algo se fizer sentido):\n${respostas.join("\n")}`
      : "Ainda não sabemos nada do perfil dele.",
    faltando.length
      ? `FALTA PERGUNTAR (uma pergunta por vez, com naturalidade): ${faltando.map((c) => c.pergunta).join(" | ")}`
      : "O perfil está completo: siga para oferecer horários.",
    ativo
      ? ativo.status === "CONFIRMADO"
        ? `AGENDAMENTO: CONFIRMADO para ${dataPorExtenso(ativo.inicio)}, ${config.formatoAtendimento}. Se ele quiser remarcar ou cancelar, use transferir_para_humano.`
        : `AGENDAMENTO: horário PRÉ-RESERVADO para ${dataPorExtenso(ativo.inicio)}, aguardando a equipe confirmar. Se ele quiser trocar, consulte e reserve outro (a reserva antiga é liberada sozinha).`
      : "",
    "",
    "FLUXO: 1) entender se é o público; 2) completar o que falta do perfil (salvar_perfil a cada resposta); 3) consultar_horarios e oferecer até 3 opções; 4) reservar_horario com a escolha; 5) avisar que o horário ficou reservado e que a equipe vai confirmar em breve por aqui.",
    `O atendimento é ${config.formatoAtendimento}.`,
    "REGRAS QUE NUNCA MUDAM:",
    "- Nunca diga que o horário está CONFIRMADO ou garantido antes da equipe confirmar. Diga 'reservado' e que a equipe confirma em breve.",
    "- Só ofereça horários que vieram de consultar_horarios. Se reservar_horario der erro, peça desculpas e ofereça outros.",
    "- Não mande links, não informe preços e não prometa resultados.",
    "- Não diga que é uma pessoa; se perguntarem, diga que é o assistente virtual da Apta.",
    "- Se a pessoa não for o público, use encerrar_fora_do_perfil; se não tiver interesse, use lead_sem_interesse.",
  ];
  return linhas.filter((l) => l !== "").join("\n");
}

/** Executa a ferramenta pedida pelo Gemini. Sempre devolve um objeto (nunca lança). */
export async function executarFerramentaLead(leadId: string, nome: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return { ok: false, erro: "Lead não encontrado" };
  try {
    switch (nome) {
      case "salvar_perfil": {
        const novos = Object.fromEntries(
          Object.entries(args).filter(([, v]) => typeof v === "string" && v.trim()).map(([k, v]) => [k, String(v).trim()])
        );
        const perfil = { ...perfilDe(lead.perfil), ...novos };
        const completo = perfilCompleto(perfil);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { perfil, ...(completo && lead.status === "EM_CONVERSA" ? { status: "DADOS_COLETADOS" } : {}) },
        });
        return { ok: true, perfilCompleto: completo, faltando: camposFaltando(perfil).map((c) => c.pergunta) };
      }
      case "consultar_horarios": {
        const quantidade = Math.min(5, Math.max(1, Number(args.quantidade) || 3));
        const aPartirDe =
          typeof args.aPartirDe === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.aPartirDe) ? instanteLocal(args.aPartirDe, "00:00") : undefined;
        const periodo = ["manha", "tarde", "noite"].includes(String(args.periodo)) ? (args.periodo as "manha" | "tarde" | "noite") : null;
        const livres = await horariosLivres({ aPartirDe, periodo, leadId: lead.id });
        const opcoes = espalhar(livres, quantidade).map(descreverHorario);
        if (!opcoes.length) {
          return { ok: true, horarios: [], aviso: "Sem horários livres nesse filtro. Tente outro período/data ou, se não houver nenhum, transfira para a equipe." };
        }
        return { ok: true, horarios: opcoes };
      }
      case "reservar_horario": {
        const inicio = new Date(String(args.inicio ?? ""));
        if (Number.isNaN(inicio.getTime())) return { ok: false, erro: "Horário inválido; use o 'inicio' de consultar_horarios." };
        const agendamento = await preReservar(lead.id, inicio);
        await avisarEquipe(lead, {
          tipo: "lead_pre_reserva",
          titulo: `Confirmar agendamento: ${lead.nome}`,
          mensagem: `O assistente reservou ${dataPorExtenso(agendamento.inicio)}. Confirme ou cancele até ${dataPorExtenso(agendamento.expiraEm!)}.`,
          severidade: "aviso",
          href: "/dashboard/agenda?aba=confirmacoes",
          chave: `pre-reserva:${agendamento.id}`,
        });
        return { ok: true, reservado: dataPorExtenso(agendamento.inicio), situacao: "PRE-RESERVADO, aguardando a equipe confirmar" };
      }
      case "encerrar_fora_do_perfil":
        await encerrarLead(lead, "FORA_DO_PERFIL", String(args.motivo ?? "Fora do perfil"));
        return { ok: true };
      case "lead_sem_interesse":
        await encerrarLead(lead, "DESCARTADO", String(args.motivo ?? "Sem interesse"));
        return { ok: true };
      case "transferir_para_humano":
        await passarParaHumano(lead, String(args.motivo ?? "Pediu para falar com a equipe"));
        return { ok: true, mensagem: "Avise que alguém da equipe vai continuar a conversa em breve." };
      default:
        return { ok: false, erro: `Ferramenta desconhecida: ${nome}` };
    }
  } catch (error) {
    if (error instanceof ConflitoAgenda) return { ok: false, erro: error.message };
    console.error("[leads] ferramenta", nome, error);
    return { ok: false, erro: "Falha interna; peça desculpas e transfira para a equipe." };
  }
}
