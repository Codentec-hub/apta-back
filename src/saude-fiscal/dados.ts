// Saúde fiscal de um cliente num mês: o que comprou (notas recebidas), o que
// vendeu/prestou (emitidas), a evolução de 12 meses, as guias do mês e as
// pendências. Tudo calculado das notas que a captura noturna guardou
// (sieg_notas) e do cadastro do sistema -- nenhuma consulta à SIEG aqui.
import { prisma } from "../prisma.js";
import { mesesRecentes } from "../sieg/notas.js";

export type Gravidade = "alta" | "media" | "baixa";

export interface Pendencia {
  id: string;
  origem: "manual" | "certificado" | "guia" | "sieg" | "obrigacao" | "cadastro";
  gravidade: Gravidade;
  titulo: string;
  detalhe: string | null;
  /** Só para a equipe: não vai para o cliente. */
  interna: boolean;
  /** Pendência manual (pode ser resolvida pela tela). */
  pendenciaId?: string;
  prazo?: string | null;
}

export interface NotaResumo {
  chave: string;
  tipo: string;
  numero: string | null;
  emissao: string | null;
  contraparteDocumento: string | null;
  contraparteNome: string | null;
  valor: number;
}

export interface DadosSaudeFiscal {
  versao: 1;
  geradoEm: string;
  mes: string;
  empresa: {
    razaoSocial: string;
    nomeFantasia: string | null;
    cnpj: string;
    regimeTributario: string | null;
    codigo: number;
  };
  naSieg: boolean;
  resumo: {
    saidas: number; // vendas + serviços prestados (emitidas)
    entradas: number; // compras + serviços tomados (recebidas)
    notasEmitidas: number;
    notasRecebidas: number;
    canceladas: number;
    servicosPrestados: number;
    servicosTomados: number;
  };
  /** Últimos 12 meses, do mais antigo ao mais recente. */
  serie: { mes: string; entradas: number; saidas: number }[];
  /** Notas que a SIEG contou x as guardadas aqui (o mês pode estar incompleto). */
  cobertura: { contadas: number; capturadas: number };
  compras: {
    fornecedores: { documento: string | null; nome: string; valor: number; notas: number }[];
    notas: NotaResumo[];
  };
  servicos: { prestados: NotaResumo[]; tomados: NotaResumo[] };
  guias: {
    nome: string;
    prazo: string;
    valor: number | null;
    situacao: "entregue" | "pendente" | "atrasada" | "dispensada";
    lida: boolean | null;
  }[];
  certificado: { expiraEm: string | null; dias: number | null };
  pendencias: Pendencia[];
}

const TIPOS_SERVICO = new Set(["nfse"]);
const LIMITE_LISTA = 300;

const primeiroDia = (mes: string) => new Date(`${mes}-01T00:00:00.000Z`);

function soma(valores: (number | null)[]): number {
  return Math.round(valores.reduce<number>((s, v) => s + (v ?? 0), 0) * 100) / 100;
}

/** Pendências do cliente: as manuais + as que o sistema enxerga sozinho. */
export async function pendenciasDoCliente(clienteId: string): Promise<Pendencia[]> {
  const cliente = await prisma.cliente.findUniqueOrThrow({
    where: { id: clienteId },
    select: { cnpj: true, contatos: { where: { ativo: true }, select: { email: true, celular: true } } },
  });
  const documento = cliente.cnpj.replace(/\D/g, "");
  const agora = new Date();
  const em7dias = new Date(agora.getTime() + 7 * 86_400_000);
  const [manuais, empresa, obrigacoes, naoLidas] = await Promise.all([
    prisma.pendenciaCliente.findMany({ where: { clienteId, resolvidaEm: null }, orderBy: { createdAt: "asc" } }),
    prisma.siegEmpresa.findFirst({ where: { documento }, orderBy: { ativo: "desc" } }),
    prisma.obrigacao.findMany({
      where: { clienteId, concluidaEm: null, dispensada: false, prazo: { lte: em7dias } },
      select: { nome: true, prazo: true },
      orderBy: { prazo: "asc" },
      take: 30,
    }),
    prisma.protocoloEntrega.findMany({
      where: {
        status: "ENVIADO",
        lidoEm: null,
        obrigacao: { clienteId, prazo: { gte: new Date(agora.getTime() - 86_400_000) } },
      },
      select: { obrigacao: { select: { nome: true, prazo: true, valorGuia: true } } },
      take: 20,
    }),
  ]);

  const saida: Pendencia[] = manuais.map((p) => ({
    id: `manual-${p.id}`,
    origem: "manual",
    gravidade: p.prazo && p.prazo < agora ? "alta" : "media",
    titulo: p.descricao,
    detalhe: p.prazo ? `Prazo: ${p.prazo.toLocaleDateString("pt-BR", { timeZone: "UTC" })}` : null,
    interna: false,
    pendenciaId: p.id,
    prazo: p.prazo?.toISOString().slice(0, 10) ?? null,
  }));

  if (empresa?.certificadoExpiraEm) {
    const dias = Math.floor((empresa.certificadoExpiraEm.getTime() - agora.getTime()) / 86_400_000);
    const data = empresa.certificadoExpiraEm.toLocaleDateString("pt-BR");
    if (dias < 0) {
      saida.push({
        id: "certificado",
        origem: "certificado",
        gravidade: "alta",
        titulo: "Certificado digital vencido",
        detalhe: `Venceu em ${data}. Sem ele não conseguimos buscar suas notas nem emitir guias.`,
        interna: false,
      });
    } else if (dias <= 30) {
      saida.push({
        id: "certificado",
        origem: "certificado",
        gravidade: "media",
        titulo: "Certificado digital perto de vencer",
        detalhe: `Vence em ${data}, daqui a ${dias} dia(s). Providencie a renovação.`,
        interna: false,
      });
    }
  }

  for (const p of naoLidas) {
    const o = p.obrigacao;
    saida.push({
      id: `guia-${o.nome}-${o.prazo.toISOString()}`,
      origem: "guia",
      gravidade: o.prazo.getTime() - agora.getTime() < 2 * 86_400_000 ? "alta" : "media",
      titulo: `Guia não aberta: ${o.nome}`,
      detalhe: `Vence em ${o.prazo.toLocaleDateString("pt-BR")}${
        o.valorGuia ? ` · ${o.valorGuia.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : ""
      }`,
      interna: false,
    });
  }

  // Daqui para baixo: só para a equipe.
  if (!empresa) {
    saida.push({
      id: "sieg-ausente",
      origem: "sieg",
      gravidade: "media",
      titulo: "Empresa não está na SIEG",
      detalhe: "Sem a SIEG não há notas para o relatório de saúde fiscal.",
      interna: true,
    });
  } else if (!empresa.ativo || empresa.deletado) {
    saida.push({
      id: "sieg-inativa",
      origem: "sieg",
      gravidade: "media",
      titulo: "Empresa inativa/excluída na SIEG",
      detalhe: null,
      interna: true,
    });
  }
  for (const o of obrigacoes) {
    const atrasada = o.prazo < agora;
    saida.push({
      id: `obrigacao-${o.nome}-${o.prazo.toISOString()}`,
      origem: "obrigacao",
      gravidade: atrasada ? "alta" : "baixa",
      titulo: `${atrasada ? "Entrega atrasada" : "Entrega vencendo"}: ${o.nome}`,
      detalhe: `Prazo ${o.prazo.toLocaleDateString("pt-BR")}`,
      interna: true,
    });
  }
  if (!cliente.contatos.some((c) => c.email || c.celular)) {
    saida.push({
      id: "contato",
      origem: "cadastro",
      gravidade: "media",
      titulo: "Nenhum contato com e-mail ou WhatsApp",
      detalhe: "Cadastre um contato para o cliente receber o relatório e as guias.",
      interna: true,
    });
  }
  const peso: Record<Gravidade, number> = { alta: 0, media: 1, baixa: 2 };
  return saida.sort((a, b) => Number(a.interna) - Number(b.interna) || peso[a.gravidade] - peso[b.gravidade]);
}

function resumoNota(
  n: {
    chave: string;
    tipo: string;
    numero: string | null;
    emissao: Date | null;
    emitenteDocumento: string | null;
    emitenteNome: string | null;
    destinatarioDocumento: string | null;
    destinatarioNome: string | null;
    valor: number | null;
  },
  contraparte: "emitente" | "destinatario",
): NotaResumo {
  return {
    chave: n.chave,
    tipo: n.tipo,
    numero: n.numero,
    emissao: n.emissao?.toISOString() ?? null,
    contraparteDocumento: contraparte === "emitente" ? n.emitenteDocumento : n.destinatarioDocumento,
    contraparteNome: contraparte === "emitente" ? n.emitenteNome : n.destinatarioNome,
    valor: n.valor ?? 0,
  };
}

export async function montarSaudeFiscal(clienteId: string, mes: string): Promise<DadosSaudeFiscal> {
  const cliente = await prisma.cliente.findUniqueOrThrow({
    where: { id: clienteId },
    select: { razaoSocial: true, nomeFantasia: true, cnpj: true, regimeTributario: true, codigo: true },
  });
  const documento = cliente.cnpj.replace(/\D/g, "");
  const meses12 = mesesRecentes(12, primeiroDia(mes)).reverse();
  const inicioMes = primeiroDia(mes);
  const fimMes = new Date(Date.UTC(inicioMes.getUTCFullYear(), inicioMes.getUTCMonth() + 1, 1));

  const selecao = {
    chave: true,
    tipo: true,
    papel: true,
    numero: true,
    emissao: true,
    emitenteDocumento: true,
    emitenteNome: true,
    destinatarioDocumento: true,
    destinatarioNome: true,
    valor: true,
    cancelada: true,
  } as const;

  const [empresa, notasMes, serieBruta, contagens, obrigacoes, pendencias] = await Promise.all([
    prisma.siegEmpresa.findFirst({ where: { documento }, orderBy: { ativo: "desc" } }),
    prisma.siegNota.findMany({
      where: { documentoEmpresa: documento, mes },
      select: selecao,
      orderBy: { emissao: "asc" },
    }),
    prisma.siegNota.groupBy({
      by: ["mes", "papel"],
      where: { documentoEmpresa: documento, mes: { in: meses12 }, cancelada: false },
      _sum: { valor: true },
    }),
    prisma.siegContagem.findMany({ where: { documento, mes } }),
    prisma.obrigacao.findMany({
      where: { clienteId, OR: [{ competencia: inicioMes }, { prazo: { gte: inicioMes, lt: fimMes } }] },
      select: {
        nome: true,
        prazo: true,
        valorGuia: true,
        concluidaEm: true,
        dispensada: true,
        protocolos: { select: { lidoEm: true, status: true } },
      },
      orderBy: { prazo: "asc" },
    }),
    pendenciasDoCliente(clienteId),
  ]);

  const validas = notasMes.filter((n) => !n.cancelada);
  const emitidas = validas.filter((n) => n.papel === "emitente");
  const recebidas = validas.filter((n) => n.papel === "destinatario");

  const fornecedores = new Map<string, { documento: string | null; nome: string; valor: number; notas: number }>();
  for (const n of recebidas) {
    const k = n.emitenteDocumento ?? n.emitenteNome ?? "?";
    const f = fornecedores.get(k) ?? { documento: n.emitenteDocumento, nome: n.emitenteNome ?? "Sem nome", valor: 0, notas: 0 };
    f.valor += n.valor ?? 0;
    f.notas++;
    fornecedores.set(k, f);
  }

  const porMes = new Map<string, { entradas: number; saidas: number }>();
  for (const g of serieBruta) {
    const m = porMes.get(g.mes) ?? { entradas: 0, saidas: 0 };
    if (g.papel === "emitente") m.saidas += g._sum.valor ?? 0;
    else m.entradas += g._sum.valor ?? 0;
    porMes.set(g.mes, m);
  }

  const contadas = contagens.reduce((s, c) => s + c.nfe + c.nfce + c.cte + c.cfe + c.nfse, 0);
  const agora = new Date();
  const dias = empresa?.certificadoExpiraEm
    ? Math.floor((empresa.certificadoExpiraEm.getTime() - agora.getTime()) / 86_400_000)
    : null;

  return {
    versao: 1,
    geradoEm: agora.toISOString(),
    mes,
    empresa: {
      razaoSocial: cliente.razaoSocial,
      nomeFantasia: cliente.nomeFantasia,
      cnpj: documento,
      regimeTributario: cliente.regimeTributario,
      codigo: cliente.codigo,
    },
    naSieg: Boolean(empresa),
    resumo: {
      saidas: soma(emitidas.map((n) => n.valor)),
      entradas: soma(recebidas.map((n) => n.valor)),
      notasEmitidas: emitidas.length,
      notasRecebidas: recebidas.length,
      canceladas: notasMes.length - validas.length,
      servicosPrestados: soma(emitidas.filter((n) => TIPOS_SERVICO.has(n.tipo)).map((n) => n.valor)),
      servicosTomados: soma(recebidas.filter((n) => TIPOS_SERVICO.has(n.tipo)).map((n) => n.valor)),
    },
    serie: meses12.map((m) => ({
      mes: m,
      entradas: Math.round((porMes.get(m)?.entradas ?? 0) * 100) / 100,
      saidas: Math.round((porMes.get(m)?.saidas ?? 0) * 100) / 100,
    })),
    cobertura: { contadas, capturadas: notasMes.length },
    compras: {
      fornecedores: [...fornecedores.values()]
        .map((f) => ({ ...f, valor: Math.round(f.valor * 100) / 100 }))
        .sort((a, b) => b.valor - a.valor)
        .slice(0, 15),
      notas: recebidas
        .filter((n) => !TIPOS_SERVICO.has(n.tipo))
        .slice(0, LIMITE_LISTA)
        .map((n) => resumoNota(n, "emitente")),
    },
    servicos: {
      prestados: emitidas
        .filter((n) => TIPOS_SERVICO.has(n.tipo))
        .slice(0, LIMITE_LISTA)
        .map((n) => resumoNota(n, "destinatario")),
      tomados: recebidas
        .filter((n) => TIPOS_SERVICO.has(n.tipo))
        .slice(0, LIMITE_LISTA)
        .map((n) => resumoNota(n, "emitente")),
    },
    guias: obrigacoes.map((o) => ({
      nome: o.nome,
      prazo: o.prazo.toISOString(),
      valor: o.valorGuia,
      situacao: o.dispensada ? "dispensada" : o.concluidaEm ? "entregue" : o.prazo < agora ? "atrasada" : "pendente",
      lida: o.protocolos.length ? o.protocolos.some((p) => p.lidoEm) : null,
    })),
    certificado: { expiraEm: empresa?.certificadoExpiraEm?.toISOString() ?? null, dias },
    pendencias,
  };
}

/** Versão que vai para o cliente: sem as pendências internas da equipe. */
export function paraCliente(dados: DadosSaudeFiscal): DadosSaudeFiscal {
  return { ...dados, pendencias: dados.pendencias.filter((p) => !p.interna) };
}
