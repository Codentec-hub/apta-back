// Trilha de auditoria automática: uma extensão do Prisma registra criar,
// alterar e excluir nos cadastros feitos por um usuário logado, com o "antes e
// depois" só dos campos que mudaram. Erro na auditoria nunca derruba a ação.
import { Prisma, PrismaClient } from "@prisma/client";
import { contextoAtual } from "./contexto.js";

/** Modelo → módulo mostrado na tela. Modelos fora daqui não são auditados. */
export const MODULO_DO_MODELO: Record<string, string> = {
  Cliente: "clientes",
  ClienteResponsavel: "clientes",
  ContatoCliente: "clientes",
  Usuario: "usuarios",
  Setor: "setores",
  TipoObrigacao: "cadastro de obrigações",
  RegimeTributario: "cadastro de obrigações",
  RegimeObrigacao: "cadastro de obrigações",
  GrupoObrigacao: "cadastro de obrigações",
  GrupoObrigacaoItem: "cadastro de obrigações",
  ClienteObrigacao: "cadastro de obrigações",
  Obrigacao: "obrigações",
  Atraso: "obrigações",
  ComentarioEntrega: "obrigações",
  DocumentoEntrega: "obrigações",
  ProtocoloEntrega: "obrigações",
  Feriado: "feriados",
  ConfiguracaoEnvio: "configurações",
  ConfiguracaoGemini: "configurações",
  ConfiguracaoEvolution: "configurações",
  ConfiguracaoSieg: "configurações",
  ConfiguracaoEscritorio: "configurações",
  Demanda: "demandas",
  Atendimento: "atendimento",
  MotivoAtendimento: "atendimento",
  AgenteIA: "agentes de IA",
  LancamentoFinanceiro: "financeiro",
  PendenciaCliente: "saúde fiscal",
  RelatorioSaudeFiscal: "saúde fiscal",
  Lead: "leads",
  Agendamento: "agenda",
  DisponibilidadeAgenda: "agenda",
  BloqueioAgenda: "agenda",
  ConfiguracaoLeads: "configurações",
};

const NOME_DO_MODELO: Record<string, string> = {
  Cliente: "Cliente",
  ClienteResponsavel: "Responsável do cliente",
  ContatoCliente: "Contato",
  Usuario: "Usuário",
  Setor: "Setor",
  TipoObrigacao: "Tipo de obrigação",
  RegimeTributario: "Regime tributário",
  RegimeObrigacao: "Obrigação do regime",
  GrupoObrigacao: "Grupo de obrigações",
  GrupoObrigacaoItem: "Item do grupo",
  ClienteObrigacao: "Obrigação na empresa",
  Obrigacao: "Entrega",
  Atraso: "Atraso",
  ComentarioEntrega: "Comentário",
  DocumentoEntrega: "Documento",
  ProtocoloEntrega: "Protocolo",
  Feriado: "Feriado",
  ConfiguracaoEnvio: "Configuração de e-mails",
  ConfiguracaoGemini: "Configuração da IA",
  ConfiguracaoEvolution: "Configuração do WhatsApp",
  ConfiguracaoSieg: "Configuração da SIEG",
  ConfiguracaoEscritorio: "Dados do escritório",
  Demanda: "Demanda",
  Atendimento: "Atendimento",
  MotivoAtendimento: "Motivo de atendimento",
  AgenteIA: "Agente de IA",
  LancamentoFinanceiro: "Lançamento financeiro",
  PendenciaCliente: "Pendência",
  RelatorioSaudeFiscal: "Relatório de saúde fiscal",
  Lead: "Lead",
  Agendamento: "Agendamento",
  DisponibilidadeAgenda: "Horário de atendimento",
  BloqueioAgenda: "Bloqueio da agenda",
  ConfiguracaoLeads: "Configuração de leads",
};

const SENSIVEL = /senha|token|secret|segredo|apikey|api_key|chave(api|_api)?$|password/i;
// Carimbos que mudam sozinhos e não dizem nada a quem lê a trilha.
const IGNORAR = /^(createdAt|updatedAt|atualizadoEm|criadoEm|ultima[A-Z].*|receitaConsultadaEm)$/;

function limpar(valor: unknown): unknown {
  if (valor === null || valor === undefined) return valor ?? null;
  if (valor instanceof Date) return valor.toISOString();
  if (typeof valor === "bigint") return valor.toString();
  if (Prisma.Decimal.isDecimal(valor)) return Number(valor);
  if (Array.isArray(valor)) return valor.map(limpar);
  if (typeof valor === "object") {
    const saida: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(valor)) saida[k] = SENSIVEL.test(k) ? "•••" : limpar(v);
    return saida;
  }
  return valor;
}

// Registro lido sem include: os campos são colunas (objetos são campos JSON).
function campos(registro: unknown): Record<string, unknown> {
  if (!registro || typeof registro !== "object") return {};
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(registro)) {
    if (IGNORAR.test(k)) continue;
    saida[k] = SENSIVEL.test(k) ? (v ? "•••" : null) : limpar(v);
  }
  return saida;
}

/** Só o que mudou: { antes: {campo: velho}, depois: {campo: novo} }. Senha mudada aparece como "•••" → "(alterada)". */
export function diferenca(antes: unknown, depois: unknown) {
  const a = campos(antes);
  const d = campos(depois);
  const ra: Record<string, unknown> = {};
  const rd: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(d)])) {
    const brutoA = (antes as Record<string, unknown> | null)?.[k];
    const brutoD = (depois as Record<string, unknown> | null)?.[k];
    if (SENSIVEL.test(k)) {
      if (JSON.stringify(limparBruto(brutoA)) !== JSON.stringify(limparBruto(brutoD))) {
        ra[k] = "•••";
        rd[k] = "(alterada)";
      }
      continue;
    }
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(d[k] ?? null)) {
      ra[k] = a[k] ?? null;
      rd[k] = d[k] ?? null;
    }
  }
  return { antes: ra, depois: rd, mudou: Object.keys(rd).length > 0 };
}
const limparBruto = (v: unknown) => (v instanceof Date ? v.toISOString() : Prisma.Decimal.isDecimal(v) ? String(v) : v ?? null);

function rotulo(registro: any): string | null {
  if (!registro || typeof registro !== "object") return null;
  const v = registro.razaoSocial ?? registro.nome ?? registro.titulo ?? registro.nomeArquivo ?? registro.descricao ?? registro.motivo ?? registro.texto;
  if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
  if (registro.numero != null) return `nº ${registro.numero}`;
  return null;
}

function clienteDe(modelo: string, registro: any): string | null {
  if (!registro || typeof registro !== "object") return null;
  if (modelo === "Cliente") return registro.id ?? null;
  return typeof registro.clienteId === "string" ? registro.clienteId : null;
}

const VERBO: Record<string, string> = { criar: "criado(a)", alterar: "alterado(a)", excluir: "excluído(a)" };

async function gravar(
  base: PrismaClient,
  dados: Omit<Prisma.AuditoriaUncheckedCreateInput, "usuarioId" | "usuarioNome" | "ip">,
) {
  const ctx = contextoAtual();
  if (!ctx) return;
  try {
    await base.auditoria.create({
      data: { ...dados, usuarioId: ctx.usuarioId, usuarioNome: ctx.usuarioNome, ip: ctx.ip },
    });
  } catch (error) {
    console.error("[auditoria] não registrou", error);
  }
}

/** Registro manual (login, saída, ações sem modelo). */
export async function registrarAuditoria(
  base: PrismaClient,
  dados: {
    acao: string;
    modulo: string;
    descricao: string;
    usuarioId?: string | null;
    usuarioNome?: string | null;
    ip?: string | null;
    entidade?: string;
    entidadeId?: string;
    clienteId?: string | null;
    depois?: unknown;
  },
) {
  try {
    const ctx = contextoAtual();
    await base.auditoria.create({
      data: {
        acao: dados.acao,
        modulo: dados.modulo,
        descricao: dados.descricao,
        usuarioId: dados.usuarioId ?? ctx?.usuarioId ?? null,
        usuarioNome: dados.usuarioNome ?? ctx?.usuarioNome ?? null,
        ip: dados.ip ?? ctx?.ip ?? null,
        entidade: dados.entidade ?? null,
        entidadeId: dados.entidadeId ?? null,
        clienteId: dados.clienteId ?? null,
        depois: dados.depois === undefined ? undefined : (limpar(dados.depois) as Prisma.InputJsonValue),
      },
    });
  } catch (error) {
    console.error("[auditoria] não registrou", error);
  }
}

const UNICOS = new Set(["create", "update", "upsert", "delete"]);
const VARIOS = new Set(["createMany", "createManyAndReturn", "updateMany", "updateManyAndReturn", "deleteMany"]);

export function comAuditoria(base: PrismaClient) {
  return base.$extends({
    name: "auditoria",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const modulo = model ? MODULO_DO_MODELO[model] : undefined;
          if (!modulo || !contextoAtual() || (!UNICOS.has(operation) && !VARIOS.has(operation))) return query(args);
          const delegado = (base as any)[model.charAt(0).toLowerCase() + model.slice(1)];
          const nomeModelo = NOME_DO_MODELO[model] ?? model;
          const a = args as any;

          if (VARIOS.has(operation)) {
            const resultado: any = await query(args);
            const qtd = Array.isArray(resultado) ? resultado.length : (resultado?.count ?? 0);
            if (qtd > 0) {
              const acao = operation.startsWith("create") ? "criar" : operation.startsWith("update") ? "alterar" : "excluir";
              void gravar(base, {
                acao,
                modulo,
                entidade: model,
                descricao: `${qtd} ${nomeModelo.toLowerCase()}(s) ${VERBO[acao]} de uma vez`,
                depois: limpar({ filtro: a?.where ?? null, dados: a?.data ?? null }) as Prisma.InputJsonValue,
              });
            }
            return resultado;
          }

          const antes = operation === "create" ? null : await delegado.findUnique({ where: a.where }).catch(() => null);
          const resultado: any = await query(args);
          const id = resultado?.id ?? antes?.id;
          const depois =
            operation === "delete" ? null : id ? await delegado.findUnique({ where: { id } }).catch(() => resultado) : resultado;
          const acao = operation === "delete" ? "excluir" : antes ? "alterar" : "criar";
          const registro = depois ?? antes;
          const nome = rotulo(registro) ?? rotulo(antes);

          if (acao === "alterar") {
            const d = diferenca(antes, depois);
            if (!d.mudou) return resultado;
            const lista = Object.keys(d.depois).slice(0, 6).join(", ");
            void gravar(base, {
              acao,
              modulo,
              entidade: model,
              entidadeId: id ?? null,
              clienteId: clienteDe(model, registro),
              descricao: `${nomeModelo}${nome ? ` "${nome}"` : ""} alterado(a): ${lista}${Object.keys(d.depois).length > 6 ? "…" : ""}`,
              antes: d.antes as Prisma.InputJsonValue,
              depois: d.depois as Prisma.InputJsonValue,
            });
          } else {
            void gravar(base, {
              acao,
              modulo,
              entidade: model,
              entidadeId: id ?? null,
              clienteId: clienteDe(model, registro),
              descricao: `${nomeModelo}${nome ? ` "${nome}"` : ""} ${VERBO[acao]}`,
              antes: acao === "excluir" ? (campos(antes) as Prisma.InputJsonValue) : undefined,
              depois: acao === "criar" ? (campos(depois) as Prisma.InputJsonValue) : undefined,
            });
          }
          return resultado;
        },
      },
    },
  });
}

/** Guarda 1 ano de trilha; o resto é apagado uma vez por dia. */
export function agendarLimpezaAuditoria(base: PrismaClient): void {
  const limpar = () => {
    base.auditoria
      .deleteMany({ where: { criadoEm: { lt: new Date(Date.now() - 365 * 86_400_000) } } })
      .catch((error) => console.error("[auditoria] falha na limpeza", error));
  };
  limpar();
  setInterval(limpar, 24 * 3_600_000).unref();
}
