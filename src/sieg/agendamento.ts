// Busca agendada da SIEG (mesmo padrão de alerta-nao-lida.ts: setInterval
// de hora em hora).
//  - Toda hora: renova o token OAuth se faltar menos de 7 dias (Fase C).
//  - Uma vez por noite (a partir das 2h, horário de Brasília):
//      1. atualiza a lista de empresas e o status dos certificados;
//      2. conta as notas do mês atual e, até o dia de corte, do anterior;
//      3. captura os XMLs que ainda faltam (contadas na SIEG > guardadas
//         aqui), empresa por empresa. "Baixar XMLs" aceita 2 lotes de 50 por
//         minuto, então a primeira carga leva várias noites: a captura para às
//         8h (para não disputar a fila com quem usa o sistema de dia) e
//         continua de onde parou na noite seguinte -- o que já foi guardado
//         não é baixado de novo.
import { prisma } from "../prisma.js";
import { credenciaisConfiguradas } from "./auth.js";
import { limparRegistroChamadas } from "./cliente.js";
import { sincronizarEmpresas } from "./empresas.js";
import {
  atualizarStatusCertificado,
  capturarNotasAgora,
  contarNotasTodas,
  encerrarBuscasOrfas,
  mesesRecentes,
  TIPOS_XML,
  type Papel,
  type TipoNota,
} from "./notas.js";
import { renovarTokenSeNecessario } from "./oauth.js";

const HORA_INICIO_NOITE = 2; // 2h em Brasília
const HORA_FIM_CAPTURA = 8; // a captura de XMLs para às 8h
const INTERVALO_MINIMO_MS = 20 * 3_600_000;

let rodando = false;
let ultimaVerificacao: string | null = null;
let ultimaAcao: string | null = null;
let etapa: string | null = null;

export interface EstadoCaptura {
  situacao: "parada" | "andamento" | "concluida" | "pausada" | "erro";
  pendentes: number;
  feitas: number;
  notas: number;
  erros: string[];
  iniciadaEm: string | null;
  concluidaEm: string | null;
}
let estadoCaptura: EstadoCaptura = {
  situacao: "parada",
  pendentes: 0,
  feitas: 0,
  notas: 0,
  erros: [],
  iniciadaEm: null,
  concluidaEm: null,
};
export const estadoCapturaNoturna = () => estadoCaptura;

export function estadoAgendamento() {
  return {
    rodando,
    etapa,
    ultimaVerificacao,
    ultimaAcao,
    horario: `diariamente a partir das ${HORA_INICIO_NOITE}h (captura de XMLs até as ${HORA_FIM_CAPTURA}h)`,
  };
}

const horaBrasilia = () =>
  Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", hour: "numeric", hour12: false }));
const diaBrasilia = () =>
  Number(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo", day: "numeric" }));

async function tokenAutorizado(): Promise<boolean> {
  const c = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  return Boolean(c?.oauthToken && c.oauthExpiraEm && c.oauthExpiraEm > new Date());
}

/** Meses que ainda podem mudar na SIEG: o atual e, até o dia de corte, o anterior. */
export async function mesesAbertos(): Promise<{ meses: string[]; diaCorte: number }> {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 }, select: { diaCorte: true } });
  const diaCorte = config?.diaCorte ?? 10;
  const [atual, anterior] = mesesRecentes(2);
  return { meses: diaBrasilia() <= diaCorte ? [atual!, anterior!] : [atual!], diaCorte };
}

interface Pendente {
  documento: string;
  nome: string;
  mes: string;
  tipo: TipoNota;
  papel: Papel;
  faltam: number;
}

/** O que a SIEG contou e ainda não está guardado aqui. */
export async function capturasPendentes(meses: string[]): Promise<Pendente[]> {
  const [empresas, contagens, guardadas] = await Promise.all([
    prisma.siegEmpresa.findMany({ where: { ativo: true, deletado: false }, select: { documento: true, nome: true } }),
    prisma.siegContagem.findMany({ where: { mes: { in: meses } } }),
    prisma.siegNota.groupBy({
      by: ["documentoEmpresa", "mes", "tipo", "papel"],
      where: { mes: { in: meses } },
      _count: { _all: true },
    }),
  ]);
  const nomes = new Map(empresas.map((e) => [e.documento, e.nome]));
  const ja = new Map(guardadas.map((g) => [`${g.documentoEmpresa}|${g.mes}|${g.tipo}|${g.papel}`, g._count._all]));
  const saida: Pendente[] = [];
  for (const c of contagens) {
    const nome = nomes.get(c.documento);
    if (!nome) continue;
    for (const tipo of Object.keys(TIPOS_XML) as TipoNota[]) {
      const contadas = c[tipo];
      const faltam = contadas - (ja.get(`${c.documento}|${c.mes}|${tipo}|${c.papel}`) ?? 0);
      if (faltam > 0) saida.push({ documento: c.documento, nome, mes: c.mes, tipo, papel: c.papel as Papel, faltam });
    }
  }
  // Mês mais recente primeiro; dentro dele, quem tem menos para baixar
  // primeiro (mais empresas completas por noite).
  return saida.sort((a, b) => b.mes.localeCompare(a.mes) || a.faltam - b.faltam);
}

/** Captura noturna dos XMLs que faltam. Para no horário-limite e retoma na noite seguinte. */
export async function capturaNoturna(meses: string[], respeitarHorario = true): Promise<void> {
  const pendentes = await capturasPendentes(meses);
  estadoCaptura = {
    situacao: "andamento",
    pendentes: pendentes.length,
    feitas: 0,
    notas: 0,
    erros: [],
    iniciadaEm: new Date().toISOString(),
    concluidaEm: null,
  };
  let pausou = false;
  for (const p of pendentes) {
    if (respeitarHorario && horaBrasilia() >= HORA_FIM_CAPTURA) {
      pausou = true;
      break;
    }
    try {
      const busca = await capturarNotasAgora(p.documento, p.mes, p.tipo, p.papel);
      if (busca?.situacao === "erro") estadoCaptura.erros.push(`${p.nome} ${p.mes} ${p.tipo}: ${busca.erro}`);
      estadoCaptura.notas += busca?.notas ?? 0;
      if (busca?.erro && /401|403|autoriza/i.test(busca.erro)) break;
    } catch (error) {
      estadoCaptura.erros.push(`${p.nome}: ${error instanceof Error ? error.message : String(error)}`);
    }
    estadoCaptura.feitas++;
  }
  estadoCaptura = {
    ...estadoCaptura,
    erros: estadoCaptura.erros.slice(-30),
    situacao: pausou ? "pausada" : estadoCaptura.erros.length && !estadoCaptura.notas ? "erro" : "concluida",
    concluidaEm: new Date().toISOString(),
  };
  const resumo = `${estadoCaptura.notas} nota(s) guardada(s) em ${estadoCaptura.feitas} de ${pendentes.length} lote(s)${
    pausou ? "; parou às 8h e continua na próxima noite" : ""
  }${estadoCaptura.erros.length ? `; ${estadoCaptura.erros.length} erro(s)` : ""}`;
  await prisma.configuracaoSieg.update({
    where: { id: 1 },
    data: { ultimaCapturaEm: new Date(), ultimaCapturaResumo: resumo },
  });
}

/** Busca completa (empresas + status + contagens + XMLs). Também usada pelo botão "rodar agora". */
export async function sincronizacaoCompleta(respeitarHorario = true): Promise<void> {
  if (rodando) return;
  rodando = true;
  const erros: string[] = [];
  try {
    etapa = "empresas";
    try {
      await sincronizarEmpresas();
    } catch (error) {
      erros.push(`empresas: ${error instanceof Error ? error.message : String(error)}`);
    }
    etapa = "status dos certificados";
    const ativas = await prisma.siegEmpresa.findMany({ where: { ativo: true, deletado: false }, select: { id: true } });
    for (const e of ativas) {
      try {
        await atualizarStatusCertificado(e.id);
      } catch {
        // status é informativo; segue para a próxima
      }
    }
    const { meses } = await mesesAbertos();
    for (const mes of meses) {
      etapa = `contagem ${mes}`;
      try {
        await contarNotasTodas(mes);
      } catch (error) {
        erros.push(`contagem ${mes}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    etapa = "captura de XMLs";
    try {
      await capturaNoturna(meses, respeitarHorario);
    } catch (error) {
      erros.push(`captura: ${error instanceof Error ? error.message : String(error)}`);
    }
    await limparRegistroChamadas();
  } finally {
    rodando = false;
    etapa = null;
    await prisma.configuracaoSieg.update({
      where: { id: 1 },
      data: {
        ultimaSincronizacaoEm: new Date(),
        ultimaSincronizacaoErro: erros.length ? erros.join(" | ").slice(0, 1000) : null,
      },
    });
    ultimaAcao = `busca completa ${erros.length ? "com erros" : "ok"} em ${new Date().toISOString()}`;
  }
}

async function verificar(): Promise<void> {
  ultimaVerificacao = new Date().toISOString();
  if (!(await credenciaisConfiguradas()) || !(await tokenAutorizado())) return;
  try {
    if (await renovarTokenSeNecessario()) ultimaAcao = `token renovado em ${new Date().toISOString()}`;
  } catch (error) {
    console.error("[sieg] falha ao renovar o token OAuth", error);
  }
  if (horaBrasilia() < HORA_INICIO_NOITE || horaBrasilia() >= 6) return;
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  const ultima = config?.ultimaSincronizacaoEm?.getTime() ?? 0;
  if (Date.now() - ultima < INTERVALO_MINIMO_MS) return;
  await sincronizacaoCompleta();
}

export function agendarSieg(): void {
  void encerrarBuscasOrfas().catch(() => {});
  const rodar = () => {
    verificar().catch((erro) => console.error("[sieg] falha na busca agendada", erro));
  };
  rodar();
  setInterval(rodar, 60 * 60 * 1000).unref();
}
