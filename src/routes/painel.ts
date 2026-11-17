// Tela inicial: tudo o que o painel mostra numa chamada só, calculado aqui
// (os prazos são 23:59:59 de Fortaleza do dia do vencimento).
import type { Prisma } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prismaBase as prisma } from "../prisma.js";

export const painelRouter = Router();

painelRouter.use("/painel", autenticar);

const FUSO = "America/Fortaleza";
const OFFSET_MS = 3 * 3_600_000;
const DIA_MS = 86_400_000;
const diaDe = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: FUSO });
/** 00:00 de Fortaleza do dia AAAA-MM-DD, em UTC. */
const inicioDoDia = (dia: string) => new Date(Date.parse(`${dia}T00:00:00Z`) + OFFSET_MS);

interface Alerta {
  severidade: "error" | "warning" | "info";
  titulo: string;
  detalhe: string;
  href: string;
}

painelRouter.get("/painel", asyncHandler(async (req, res) => {
  const usuario = req.usuario!;
  const gestao = usuario.perfil === "ADMIN" || usuario.perfil === "GESTOR";
  const escopo = gestao && req.query.escopo !== "meu" ? "escritorio" : "meu";
  const filtro: Prisma.ObrigacaoWhereInput = { dispensada: false, ...(escopo === "meu" ? { responsavelId: usuario.usuarioId } : {}) };

  const agora = new Date();
  const hoje = diaDe(agora);
  const inicioHoje = inicioDoDia(hoje);
  const fimHoje = new Date(inicioHoje.getTime() + DIA_MS - 1);
  const fimSemana = new Date(inicioHoje.getTime() + 7 * DIA_MS - 1);
  const fim14 = new Date(inicioHoje.getTime() + 14 * DIA_MS - 1);
  const [ano, mes] = hoje.split("-").map(Number) as [number, number];
  const inicioMes = inicioDoDia(`${ano}-${String(mes).padStart(2, "0")}-01`);
  const proxMes = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
  const fimMes = new Date(inicioDoDia(proxMes).getTime() - 1);
  // 8 semanas (segunda a domingo) até a atual.
  const diasDesdeSegunda = (new Date(`${hoje}T12:00:00Z`).getUTCDay() + 6) % 7;
  const inicioSemanaAtual = new Date(inicioHoje.getTime() - diasDesdeSegunda * DIA_MS);
  const inicio8Semanas = new Date(inicioSemanaAtual.getTime() - 7 * 7 * DIA_MS);

  const [clientesAtivos, doMes, abertasAte14, entreguesRecentes, guiasNaoLidas, atendimentosAbertos, pendencias] = await Promise.all([
    prisma.cliente.count({ where: { ativo: true } }),
    prisma.obrigacao.findMany({
      where: { ...filtro, prazo: { gte: inicioMes, lte: fimMes } },
      select: { prazo: true, concluidaEm: true, setor: { select: { nome: true } } },
    }),
    prisma.obrigacao.findMany({
      where: { ...filtro, concluidaEm: null, prazo: { lte: fim14 } },
      orderBy: { prazo: "asc" },
      select: {
        id: true,
        nome: true,
        prazo: true,
        prazoTecnico: true,
        cliente: { select: { id: true, razaoSocial: true, nomeFantasia: true } },
        setor: { select: { nome: true } },
        responsavel: { select: { id: true, nome: true } },
        atraso: { select: { id: true } },
      },
    }),
    prisma.obrigacao.findMany({
      where: { ...filtro, concluidaEm: { gte: inicio8Semanas } },
      select: { prazo: true, concluidaEm: true },
    }),
    prisma.protocoloEntrega.count({
      where: { status: "ENVIADO", lidoEm: null, obrigacao: filtro },
    }),
    prisma.atendimento.count({
      where: { status: { in: ["AGUARDANDO", "EM_ATENDIMENTO"] }, ...(escopo === "meu" ? { responsavelId: usuario.usuarioId } : {}) },
    }),
    prisma.pendenciaCliente.findMany({ where: { resolvidaEm: null }, select: { prazo: true } }),
  ]);

  // Indicadores do mês (vencimento no mês).
  let entreguesNoPrazo = 0;
  let entreguesAtrasadas = 0;
  let pendentesNoPrazo = 0;
  let vencidasNoMes = 0;
  const setores = new Map<string, { setor: string; total: number; noPrazo: number; atrasadas: number; pendentes: number }>();
  for (const o of doMes) {
    const nomeSetor = o.setor?.nome ?? "Sem setor";
    const s = setores.get(nomeSetor) ?? { setor: nomeSetor, total: 0, noPrazo: 0, atrasadas: 0, pendentes: 0 };
    s.total += 1;
    if (o.concluidaEm) {
      if (o.concluidaEm <= o.prazo) {
        entreguesNoPrazo += 1;
        s.noPrazo += 1;
      } else {
        entreguesAtrasadas += 1;
        s.atrasadas += 1;
      }
    } else if (o.prazo < agora) {
      vencidasNoMes += 1;
      s.atrasadas += 1;
    } else {
      pendentesNoPrazo += 1;
      s.pendentes += 1;
    }
    setores.set(nomeSetor, s);
  }
  const comDesfecho = entreguesNoPrazo + entreguesAtrasadas + vencidasNoMes;

  // Agenda: vencidas, hoje e próximos 7 dias.
  const situacao = (prazo: Date) => (prazo < agora ? "atrasada" : prazo <= fimHoje ? "hoje" : prazo <= fimSemana ? "semana" : "depois");
  const vencidas = abertasAte14.filter((o) => o.prazo < agora);
  const agenda = abertasAte14
    .filter((o) => situacao(o.prazo) !== "depois")
    .slice(0, 40)
    .map((o) => ({
      id: o.id,
      nome: o.nome,
      prazo: o.prazo,
      prazoTecnico: o.prazoTecnico,
      cliente: o.cliente,
      setor: o.setor?.nome ?? null,
      responsavel: o.responsavel,
      justificada: Boolean(o.atraso),
      situacao: situacao(o.prazo),
    }));

  // Vencimentos por dia (próximos 14 dias, a partir de hoje).
  const porDia = Array.from({ length: 14 }, (_, i) => {
    const dia = diaDe(new Date(inicioHoje.getTime() + i * DIA_MS + 12 * 3_600_000));
    return { dia, total: 0 };
  });
  const indiceDia = new Map(porDia.map((d, i) => [d.dia, i]));
  for (const o of abertasAte14) {
    if (o.prazo < inicioHoje) continue;
    const i = indiceDia.get(diaDe(o.prazo));
    if (i !== undefined) porDia[i]!.total += 1;
  }

  // Entregas por semana (8 semanas), no prazo x com atraso.
  const semanas = Array.from({ length: 8 }, (_, i) => ({
    inicio: diaDe(new Date(inicio8Semanas.getTime() + i * 7 * DIA_MS + 12 * 3_600_000)),
    noPrazo: 0,
    atrasadas: 0,
  }));
  for (const o of entreguesRecentes) {
    const i = Math.floor((o.concluidaEm!.getTime() - inicio8Semanas.getTime()) / (7 * DIA_MS));
    const s = semanas[i];
    if (!s) continue;
    if (o.concluidaEm! <= o.prazo) s.noPrazo += 1;
    else s.atrasadas += 1;
  }

  // Alertas.
  const alertas: Alerta[] = [];
  const semJustificativa = vencidas.filter((o) => !o.atraso).length;
  if (semJustificativa)
    alertas.push({
      severidade: "error",
      titulo: `${semJustificativa} entrega(s) atrasada(s) sem justificativa`,
      detalhe: "Registre a justificativa e o plano de ação, ou conclua a entrega.",
      href: "/dashboard/obrigacoes",
    });
  if (guiasNaoLidas)
    alertas.push({
      severidade: "warning",
      titulo: `${guiasNaoLidas} guia(s) enviada(s) e ainda não lida(s)`,
      detalhe: "O cliente recebeu o protocolo mas não abriu o documento.",
      href: "/dashboard/obrigacoes",
    });
  const pendenciasVencidas = pendencias.filter((p) => p.prazo && p.prazo < agora).length;
  if (pendencias.length)
    alertas.push({
      severidade: pendenciasVencidas ? "warning" : "info",
      titulo: `${pendencias.length} pendência(s) de clientes em aberto`,
      detalhe: pendenciasVencidas ? `${pendenciasVencidas} já passaram do prazo.` : "Acompanhe na ficha de cada cliente.",
      href: "/dashboard/clientes",
    });

  let sieg: { notasNoMes: number; empresas: number; ultimaCaptura: string | null } | null = null;
  if (gestao) {
    const em30 = new Date(agora.getTime() + 30 * DIA_MS);
    const mesSieg = `${ano}-${String(mes).padStart(2, "0")}`;
    const [certificados, config, notasNoMes, empresas] = await Promise.all([
      prisma.siegEmpresa.findMany({
        where: { ativo: true, deletado: false, certificadoExpiraEm: { lte: em30 } },
        select: { nome: true, certificadoExpiraEm: true },
        orderBy: { certificadoExpiraEm: "asc" },
      }),
      prisma.configuracaoSieg.findUnique({ where: { id: 1 } }),
      prisma.siegNota.count({ where: { mes: mesSieg } }),
      prisma.siegEmpresa.count({ where: { ativo: true, deletado: false } }),
    ]);
    const vencidos = certificados.filter((c) => c.certificadoExpiraEm! < agora);
    if (vencidos.length)
      alertas.push({
        severidade: "error",
        titulo: `${vencidos.length} certificado(s) digital(is) vencido(s)`,
        detalhe: vencidos.slice(0, 3).map((c) => c.nome).join(", ") + (vencidos.length > 3 ? "…" : ""),
        href: "/dashboard/sieg",
      });
    const aVencer = certificados.length - vencidos.length;
    if (aVencer)
      alertas.push({
        severidade: "warning",
        titulo: `${aVencer} certificado(s) vencem em até 30 dias`,
        detalhe: certificados
          .filter((c) => c.certificadoExpiraEm! >= agora)
          .slice(0, 3)
          .map((c) => `${c.nome} (${c.certificadoExpiraEm!.toLocaleDateString("pt-BR", { timeZone: FUSO })})`)
          .join(", "),
        href: "/dashboard/sieg",
      });
    if (config?.oauthExpiraEm && config.oauthExpiraEm.getTime() - agora.getTime() < 5 * DIA_MS)
      alertas.push({
        severidade: config.oauthExpiraEm < agora ? "error" : "warning",
        titulo: config.oauthExpiraEm < agora ? "Acesso à SIEG expirado" : "Acesso à SIEG vence em breve",
        detalhe: "Autorize de novo em Integrações → SIEG para a captura de notas continuar.",
        href: "/dashboard/integracoes/sieg",
      });
    if (config?.ultimaSincronizacaoErro)
      alertas.push({
        severidade: "info",
        titulo: "A última busca na SIEG teve erros",
        detalhe: config.ultimaSincronizacaoErro.slice(0, 160),
        href: "/dashboard/sieg",
      });
    sieg = { notasNoMes, empresas, ultimaCaptura: config?.ultimaCapturaResumo ?? null };
  }

  res.json({
    escopo,
    podeVerEscritorio: gestao,
    hoje,
    kpis: {
      clientesAtivos,
      mes: {
        total: doMes.length,
        entregues: entreguesNoPrazo + entreguesAtrasadas,
        entreguesNoPrazo,
        entreguesAtrasadas,
        pendentesNoPrazo,
        vencidasNoMes,
        percentualNoPrazo: comDesfecho ? Math.round((entreguesNoPrazo / comDesfecho) * 100) : null,
      },
      vencidas: vencidas.length,
      venceHoje: abertasAte14.filter((o) => situacao(o.prazo) === "hoje").length,
      venceSemana: abertasAte14.filter((o) => o.prazo >= agora && o.prazo <= fimSemana).length,
      guiasNaoLidas,
      atendimentosAbertos,
      pendenciasClientes: pendencias.length,
    },
    agenda,
    porDia,
    semanas,
    porSetor: [...setores.values()].sort((a, b) => b.total - a.total),
    alertas,
    sieg,
  });
}));
