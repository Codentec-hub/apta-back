// Avisos agendados (de hora em hora, das 7h às 20h em Fortaleza). Cada aviso
// tem uma `chave`, então rodar de novo não repete o que já foi avisado.
import { prismaBase as prisma } from "../prisma.js";
import { idsDaGestao, notificar } from "./notificar.js";

const FUSO = "America/Fortaleza";
const DIA_MS = 86_400_000;
const OFFSET_MS = 3 * 3_600_000;
const diaDe = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: FUSO });
const dataBr = (d: Date) => d.toLocaleDateString("pt-BR", { timeZone: FUSO });
const inicioDoDia = (dia: string) => new Date(Date.parse(`${dia}T00:00:00Z`) + OFFSET_MS);
const horaLocal = () => Number(new Date().toLocaleString("en-US", { timeZone: FUSO, hour: "numeric", hour12: false }));
const buscaCliente = (nome: string) => `/dashboard/obrigacoes?busca=${encodeURIComponent(nome)}`;

/** Responsável da entrega; sem ele, o responsável do setor. */
function quemResponde(o: { responsavelId: string | null; setor: { responsavelId: string | null } | null }) {
  return o.responsavelId ?? o.setor?.responsavelId ?? null;
}

async function prazos(agora: Date) {
  const hoje = diaDe(agora);
  const inicioHoje = inicioDoDia(hoje);
  const fimAmanha = new Date(inicioHoje.getTime() + 2 * DIA_MS - 1);
  const amanha = diaDe(new Date(inicioHoje.getTime() + DIA_MS + 12 * 3_600_000));
  const abertas = await prisma.obrigacao.findMany({
    where: { concluidaEm: null, dispensada: false, prazo: { gte: new Date(agora.getTime() - 10 * DIA_MS), lte: fimAmanha } },
    select: {
      id: true,
      nome: true,
      prazo: true,
      responsavelId: true,
      setor: { select: { responsavelId: true } },
      cliente: { select: { razaoSocial: true } },
      atraso: { select: { id: true } },
    },
  });
  for (const o of abertas) {
    const quem = quemResponde(o);
    if (!quem) continue;
    const dia = diaDe(o.prazo);
    const base = { href: buscaCliente(o.cliente.razaoSocial), dados: { obrigacaoId: o.id } };
    if (dia === amanha) {
      await notificar([quem], {
        ...base,
        tipo: "entrega_vence_amanha",
        titulo: `Vence amanhã: ${o.nome}`,
        mensagem: `"${o.nome}" de ${o.cliente.razaoSocial} vence amanhã (${dataBr(o.prazo)}).`,
        chave: `vence-amanha:${o.id}:${dia}`,
      });
    } else if (dia === hoje && o.prazo > agora) {
      await notificar([quem], {
        ...base,
        tipo: "entrega_vence_hoje",
        titulo: `Vence hoje: ${o.nome}`,
        mensagem: `"${o.nome}" de ${o.cliente.razaoSocial} vence hoje.`,
        severidade: "aviso",
        chave: `vence-hoje:${o.id}:${dia}`,
      });
    } else if (o.prazo < agora && !o.atraso) {
      await notificar([quem], {
        ...base,
        tipo: "entrega_atrasada",
        titulo: `Atrasada: ${o.nome}`,
        mensagem: `"${o.nome}" de ${o.cliente.razaoSocial} venceu em ${dataBr(o.prazo)} e não foi concluída nem justificada. Registre a justificativa e o plano de ação.`,
        severidade: "erro",
        chave: `atrasada:${o.id}`,
      });
    }
  }

  // Resumo para a gestão, uma vez por dia a partir das 8h.
  if (horaLocal() >= 8) {
    const atrasadas = await prisma.obrigacao.count({ where: { concluidaEm: null, dispensada: false, prazo: { lt: agora } } });
    const semJustificativa = await prisma.obrigacao.count({
      where: { concluidaEm: null, dispensada: false, prazo: { lt: agora }, atraso: null },
    });
    if (atrasadas > 0)
      await notificar(await idsDaGestao(), {
        tipo: "resumo_atrasadas",
        titulo: `${atrasadas} entrega(s) atrasada(s) no escritório`,
        mensagem: `Hoje há ${atrasadas} entrega(s) com prazo legal vencido${semJustificativa ? `, ${semJustificativa} sem justificativa` : ""}.`,
        href: "/dashboard",
        severidade: semJustificativa ? "erro" : "aviso",
        chave: `resumo-atrasadas:${hoje}`,
      });
  }
}

async function planosVencidos(agora: Date) {
  const planos = await prisma.atraso.findMany({
    where: { cumprido: false, prazoPrometido: { lt: agora }, obrigacao: { concluidaEm: null } },
    select: {
      id: true,
      prazoPrometido: true,
      obrigacao: {
        select: { id: true, nome: true, responsavelId: true, setor: { select: { responsavelId: true } }, cliente: { select: { razaoSocial: true } } },
      },
    },
  });
  for (const p of planos) {
    const o = p.obrigacao;
    await notificar([quemResponde(o)], {
      tipo: "plano_vencido",
      titulo: `Plano de ação vencido: ${o.nome}`,
      mensagem: `O plano de ação de "${o.nome}" (${o.cliente.razaoSocial}) era até ${dataBr(p.prazoPrometido)} e a entrega segue aberta.`,
      href: buscaCliente(o.cliente.razaoSocial),
      severidade: "erro",
      chave: `plano:${p.id}:${p.prazoPrometido.toISOString().slice(0, 10)}`,
      dados: { obrigacaoId: o.id },
    });
  }
}

async function guiasNaoLidas(agora: Date) {
  const protocolos = await prisma.protocoloEntrega.findMany({
    where: { status: "ENVIADO", lidoEm: null, enviadoEm: { lt: new Date(agora.getTime() - 3 * DIA_MS), gt: new Date(agora.getTime() - 30 * DIA_MS) } },
    select: {
      id: true,
      numero: true,
      destinatarioNome: true,
      enviadoEm: true,
      usuarioId: true,
      obrigacao: { select: { id: true, nome: true, responsavelId: true, cliente: { select: { razaoSocial: true } } } },
    },
  });
  for (const p of protocolos) {
    await notificar([p.usuarioId ?? p.obrigacao.responsavelId], {
      tipo: "guia_nao_lida",
      titulo: `Guia não lida: ${p.obrigacao.nome}`,
      mensagem: `${p.destinatarioNome} (${p.obrigacao.cliente.razaoSocial}) ainda não abriu o protocolo nº ${p.numero}, enviado em ${dataBr(p.enviadoEm!)}. Vale um contato.`,
      href: buscaCliente(p.obrigacao.cliente.razaoSocial),
      severidade: "aviso",
      chave: `nao-lida:${p.id}`,
      dados: { obrigacaoId: p.obrigacao.id, protocoloId: p.id },
    });
  }
}

async function pendenciasDeClientes(agora: Date) {
  const pendencias = await prisma.pendenciaCliente.findMany({
    where: { resolvidaEm: null, prazo: { lt: agora }, usuarioId: { not: null } },
    select: { id: true, descricao: true, prazo: true, usuarioId: true, cliente: { select: { id: true, razaoSocial: true } } },
  });
  for (const p of pendencias) {
    await notificar([p.usuarioId], {
      tipo: "pendencia_cliente",
      titulo: `Pendência vencida: ${p.cliente.razaoSocial}`,
      mensagem: `"${p.descricao}" era até ${dataBr(p.prazo!)} e segue aberta.`,
      href: `/dashboard/clientes/${p.cliente.id}`,
      severidade: "aviso",
      chave: `pendencia:${p.id}:${p.prazo!.toISOString().slice(0, 10)}`,
    });
  }
}

async function certificadosESieg(agora: Date) {
  const gestao = await idsDaGestao();
  if (!gestao.length) return;
  const empresas = await prisma.siegEmpresa.findMany({
    where: { ativo: true, deletado: false, certificadoExpiraEm: { lte: new Date(agora.getTime() + 30 * DIA_MS), gte: new Date(agora.getTime() - 60 * DIA_MS) } },
    select: { id: true, nome: true, certificadoExpiraEm: true },
  });
  for (const e of empresas) {
    const vence = e.certificadoExpiraEm!;
    const dias = Math.ceil((vence.getTime() - agora.getTime()) / DIA_MS);
    if (dias < 0) {
      await notificar(gestao, {
        tipo: "certificado_vencido",
        titulo: `Certificado vencido: ${e.nome}`,
        mensagem: `O certificado digital de ${e.nome} venceu em ${dataBr(vence)}. Sem um certificado válido, a SIEG para de capturar as notas desse cliente.`,
        href: "/dashboard/sieg",
        severidade: "erro",
        chave: `cert-vencido:${e.id}:${vence.toISOString().slice(0, 10)}`,
      });
    } else {
      const marco = dias <= 7 ? 7 : dias <= 15 ? 15 : 30;
      await notificar(gestao, {
        tipo: "certificado_vencendo",
        titulo: `Certificado vence em ${dias} dia(s): ${e.nome}`,
        mensagem: `O certificado digital de ${e.nome} vence em ${dataBr(vence)}. Peça a renovação ao cliente.`,
        href: "/dashboard/sieg",
        severidade: marco === 7 ? "erro" : "aviso",
        chave: `cert:${e.id}:${vence.toISOString().slice(0, 10)}:${marco}`,
      });
    }
  }

  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  if (config?.oauthExpiraEm && config.oauthExpiraEm.getTime() - agora.getTime() < 5 * DIA_MS) {
    const expirou = config.oauthExpiraEm < agora;
    await notificar(gestao, {
      tipo: "sieg_acesso",
      titulo: expirou ? "Acesso à SIEG expirado" : "Acesso à SIEG vence em breve",
      mensagem: expirou
        ? "A autorização da SIEG venceu e a captura de notas parou. Autorize de novo em Integrações → SIEG."
        : `A autorização da SIEG vence em ${dataBr(config.oauthExpiraEm)}. Se a renovação automática falhar, autorize de novo em Integrações → SIEG.`,
      href: "/dashboard/integracoes/sieg",
      severidade: expirou ? "erro" : "aviso",
      chave: `sieg-acesso:${config.oauthExpiraEm.toISOString().slice(0, 10)}:${expirou ? "expirou" : "vence"}`,
    });
  }
  if (config?.ultimaSincronizacaoErro && config.ultimaSincronizacaoEm && agora.getTime() - config.ultimaSincronizacaoEm.getTime() < DIA_MS) {
    await notificar(gestao, {
      tipo: "sieg_erro",
      titulo: "A busca da SIEG terminou com erros",
      mensagem: config.ultimaSincronizacaoErro.slice(0, 400),
      href: "/dashboard/sieg",
      severidade: "aviso",
      chave: `sieg-erro:${diaDe(config.ultimaSincronizacaoEm)}`,
    });
  }
}

async function clientesSemEmail(agora: Date) {
  // Toda segunda-feira (a chave é a semana).
  if (new Date(`${diaDe(agora)}T12:00:00Z`).getUTCDay() !== 1) return;
  const semEmail = await prisma.cliente.count({
    where: { ativo: true, contatos: { none: { AND: [{ email: { not: null } }, { NOT: { email: "" } }] } } },
  });
  if (!semEmail) return;
  await notificar(await idsDaGestao(), {
    tipo: "clientes_sem_email",
    titulo: `${semEmail} cliente(s) sem e-mail de contato`,
    mensagem: `${semEmail} cliente(s) ativo(s) não têm contato com e-mail. Sem isso, o protocolo das obrigações não tem para quem ir.`,
    href: "/dashboard/clientes",
    chave: `sem-email:${diaDe(agora)}`,
  });
}

let rodando = false;

export async function rodarRotinaNotificacoes(): Promise<void> {
  if (rodando) return;
  const hora = horaLocal();
  if (hora < 7 || hora >= 20) return;
  rodando = true;
  const agora = new Date();
  try {
    for (const etapa of [prazos, planosVencidos, guiasNaoLidas, pendenciasDeClientes, certificadosESieg, clientesSemEmail]) {
      try {
        await etapa(agora);
      } catch (error) {
        console.error(`[notificacoes] etapa ${etapa.name} falhou`, error);
      }
    }
    // Limpeza: lidas há mais de 90 dias e arquivadas há mais de 30.
    await prisma.notificacao.deleteMany({
      where: {
        OR: [
          { lidaEm: { lt: new Date(agora.getTime() - 90 * DIA_MS) } },
          { arquivadaEm: { lt: new Date(agora.getTime() - 30 * DIA_MS) } },
        ],
      },
    });
  } finally {
    rodando = false;
  }
}

export function agendarNotificacoes(): void {
  const rodar = () => void rodarRotinaNotificacoes().catch((e) => console.error("[notificacoes] rotina falhou", e));
  setTimeout(rodar, 60_000).unref();
  setInterval(rodar, 60 * 60_000).unref();
}
