// Notas fiscais da SIEG: contagem por mês, captura da lista de notas,
// XML/DANFE/eventos de uma nota, relatórios prontos e status do certificado.
// Tudo SOMENTE LEITURA, via chamarSieg (que respeita o limite de cada rota).
import { gunzipSync, gzipSync } from "node:zlib";

import { prisma } from "../prisma.js";
import { descreverResposta, EVENTOS_CANCELAMENTO, extrairArquivos, montarZip, resumirXml, type ArquivoSieg } from "./arquivos.js";
import { chamarSieg, ErroSieg } from "./cliente.js";

export const TIPOS_XML = { nfe: 1, cte: 2, nfse: 3, nfce: 4, cfe: 5 } as const;
export type TipoNota = keyof typeof TIPOS_XML;
export type Papel = "emitente" | "destinatario";

/**
 * Primeiro e último instante do mês AAAA-MM no formato aceito pela SIEG.
 * Para NFS-e a SIEG só aceita data sem hora ("Certifique-se de apenas passar
 * dia/mês/ano em NFSe", HTTP 400 visto em produção em 04/11/2026).
 */
export function limitesMes(mes: string, soData = false): { inicio: string; fim: string } {
  const [ano, m] = mes.split("-").map(Number) as [number, number];
  const ultimo = `${mes}-${String(new Date(Date.UTC(ano, m, 0)).getUTCDate()).padStart(2, "0")}`;
  return soData
    ? { inicio: `${mes}-01`, fim: ultimo }
    : { inicio: `${mes}-01T00:00:00.000`, fim: `${ultimo}T23:59:59.999` };
}

export function mesesRecentes(quantos: number, base = new Date()): string[] {
  const saida: string[] = [];
  for (let i = 0; i < quantos; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    saida.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return saida;
}

const filtroPapel = (papel: Papel, documento: string) =>
  papel === "emitente" ? { CnpjEmit: documento } : { CnpjDest: documento };

// ---------------------------------------------------------------- contagens

interface Contagem {
  NFe?: number;
  NFCe?: number;
  CTe?: number;
  CFe?: number;
  NFSe?: number;
}

const CHAVES_CONTAGEM = ["NFe", "NFCe", "CTe", "CFe", "NFSe"] as const;

/**
 * Acha os números da contagem em qualquer formato de resposta: objeto puro
 * (exemplo da doc), dentro de Data/data (envelope das outras rotas) ou com as
 * chaves em minúsculas. Devolve null se não achar nada parecido.
 */
export function lerContagem(corpo: unknown): Contagem | null {
  const visitar = (v: unknown, prof: number): Contagem | null => {
    if (!v || typeof v !== "object" || prof > 4) return null;
    const o = v as Record<string, unknown>;
    const achadas: Contagem = {};
    let tem = false;
    for (const chave of CHAVES_CONTAGEM) {
      const valor = o[chave] ?? o[chave.toLowerCase()] ?? o[chave.toUpperCase()];
      if (valor !== undefined && valor !== null && Number.isFinite(Number(valor))) {
        achadas[chave] = Number(valor);
        tem = true;
      }
    }
    if (tem) return achadas;
    for (const filho of Object.values(o)) {
      const r = visitar(filho, prof + 1);
      if (r) return r;
    }
    return null;
  };
  return visitar(corpo, 0);
}

/** Conta as notas de uma empresa num mês (emitidas e recebidas) e grava. */
export async function contarNotasEmpresa(documento: string, mes: string): Promise<void> {
  const { inicio, fim } = limitesMes(mes);
  for (const papel of ["emitente", "destinatario"] as Papel[]) {
    const resposta = await chamarSieg<unknown>("/api/v1/contar-xmls", {
      corpo: { ...filtroPapel(papel, documento), DataEmissaoInicio: inicio, DataEmissaoFim: fim },
    });
    const envelope = resposta as { IsSuccess?: boolean; success?: boolean } | null;
    const sucessoSemNumeros = resposta === null || envelope?.IsSuccess === true || envelope?.success === true;
    const c = lerContagem(resposta) ?? (sucessoSemNumeros ? {} : null);
    if (!c) {
      // Formato inesperado: melhor avisar do que gravar zero como se não houvesse notas.
      throw new Error(`A SIEG respondeu a contagem num formato desconhecido: ${JSON.stringify(resposta).slice(0, 200)}`);
    }
    const dados = {
      nfe: Number(c?.NFe ?? 0),
      nfce: Number(c?.NFCe ?? 0),
      cte: Number(c?.CTe ?? 0),
      cfe: Number(c?.CFe ?? 0),
      nfse: Number(c?.NFSe ?? 0),
    };
    await prisma.siegContagem.upsert({
      where: { documento_mes_papel: { documento, mes, papel } },
      create: { documento, mes, papel, ...dados },
      update: dados,
    });
  }
}

export interface EstadoContagem {
  situacao: "parada" | "andamento" | "concluida" | "erro";
  mes: string | null;
  feitas: number;
  total: number;
  erros: string[];
  iniciadaEm: string | null;
  concluidaEm: string | null;
}
let estadoContagem: EstadoContagem = {
  situacao: "parada",
  mes: null,
  feitas: 0,
  total: 0,
  erros: [],
  iniciadaEm: null,
  concluidaEm: null,
};
export const estadoContagens = () => estadoContagem;

/** Conta as notas de todas as empresas ativas na SIEG num mês (em segundo plano). */
export async function contarNotasTodas(mes: string): Promise<void> {
  const empresas = await prisma.siegEmpresa.findMany({
    where: { ativo: true, deletado: false },
    select: { documento: true, nome: true },
    orderBy: { nome: "asc" },
  });
  estadoContagem = {
    situacao: "andamento",
    mes,
    feitas: 0,
    total: empresas.length,
    erros: [],
    iniciadaEm: new Date().toISOString(),
    concluidaEm: null,
  };
  for (const e of empresas) {
    try {
      await contarNotasEmpresa(e.documento, mes);
    } catch (error) {
      estadoContagem.erros.push(`${e.nome}: ${error instanceof Error ? error.message : String(error)}`);
      // Sem autorização/credencial não adianta continuar empresa por empresa.
      if (error instanceof ErroSieg && (error.status === 401 || error.status === 403)) break;
    }
    estadoContagem = { ...estadoContagem, feitas: estadoContagem.feitas + 1 };
  }
  estadoContagem = {
    ...estadoContagem,
    situacao: estadoContagem.erros.length && estadoContagem.feitas === 0 ? "erro" : "concluida",
    concluidaEm: new Date().toISOString(),
  };
}

export function iniciarContagemTodas(mes: string): EstadoContagem {
  if (estadoContagem.situacao !== "andamento")
    void contarNotasTodas(mes).catch((e) => console.error("[sieg] falha na contagem", e));
  return estadoContagem;
}

// ---------------------------------------------------- captura de notas (lista)

const buscasEmAndamento = new Set<string>();

/**
 * Grava uma nota (resumo + XML compactado) ou aplica um evento. O mês gravado
 * é o do filtro usado na SIEG, não o da data de emissão em UTC: assim a
 * comparação "contadas x capturadas" bate (uma nota das 22h do dia 31 em
 * Brasília já é dia 1º em UTC).
 */
async function gravarResumo(
  xml: string,
  documento: string,
  papel: Papel,
  mes: string,
  tipoPadrao: TipoNota,
  canceladas: Set<string>,
  chaves?: Set<string>,
): Promise<"nota" | "evento" | null> {
  const r = resumirXml(xml);
  if (!r || !r.chave) return null;
  if (r.ehEvento) {
    // Aplicado no fim da captura: o evento pode vir antes da nota.
    if (r.tipoEvento && EVENTOS_CANCELAMENTO.has(r.tipoEvento)) canceladas.add(r.chave);
    return "evento";
  }
  const dados = {
    tipo: r.tipo ?? tipoPadrao,
    documentoEmpresa: documento,
    papel,
    mes,
    emissao: r.emissao,
    numero: r.numero,
    serie: r.serie,
    emitenteDocumento: r.emitenteDocumento,
    emitenteNome: r.emitenteNome,
    destinatarioDocumento: r.destinatarioDocumento,
    destinatarioNome: r.destinatarioNome,
    valor: r.valor,
    naturezaOperacao: r.naturezaOperacao,
    xml: gzipSync(Buffer.from(xml, "utf8")),
  };
  await prisma.siegNota.upsert({ where: { chave: r.chave }, create: { chave: r.chave, ...dados }, update: dados });
  chaves?.add(r.chave);
  return "nota";
}

/**
 * Se a SIEG contou mais notas do que a busca trouxe, explica o que veio
 * (aparece na tela ao lado de "Última busca").
 */
async function avisoIncompleto(
  documento: string,
  mes: string,
  tipo: TipoNota,
  papel: Papel,
  stats: { arquivos: number; xmls: number; eventos: number; naoReconhecidos: number; chaves: Set<string> },
  paginas: number,
  porFiltro: string[] = [],
): Promise<string | null> {
  const contagem = await prisma.siegContagem.findUnique({ where: { documento_mes_papel: { documento, mes, papel } } });
  const contadas = contagem?.[tipo] ?? 0;
  if (stats.chaves.size >= contadas) {
    return porFiltro.length > 1 ? `Completa. Notas novas por filtro: ${porFiltro.join(", ")}.` : null;
  }
  return `A SIEG contou ${contadas} e entregou ${stats.arquivos} arquivo(s) em ${paginas} página(s): ${stats.xmls} XML, ${
    stats.chaves.size
  } nota(s) diferentes, ${stats.eventos} evento(s), ${stats.naoReconhecidos} não reconhecido(s).${
    porFiltro.length > 1 ? ` Notas novas por filtro: ${porFiltro.join(", ")}.` : ""
  }`;
}

/**
 * Captura a lista de notas de uma empresa num mês (um tipo e um papel), em
 * páginas de 50. "Baixar XMLs" aceita só 2 requisições por minuto, então uma
 * empresa com 500 notas leva ~5 minutos; o andamento fica em sieg_buscas_notas.
 */
async function capturarNotas(buscaId: string, documento: string, mes: string, tipo: TipoNota, papel: Papel) {
  const { inicio, fim } = limitesMes(mes, tipo === "nfse");
  let paginas = 0;
  let gravadas = 0;
  const canceladas = new Set<string>();
  // Quando a busca termina sem nenhuma nota, guarda o que a SIEG respondeu na
  // 1ª página (aparece na tela) -- para achar diferença de formato da API real.
  let diagnostico: string | null = null;
  const stats = { arquivos: 0, xmls: 0, eventos: 0, naoReconhecidos: 0, chaves: new Set<string>() };
  const porFiltro: string[] = [];

  /** Percorre as páginas de um filtro; devolve quantas notas novas trouxe. */
  const percorrer = async (filtro: Record<string, unknown>, primeiro: boolean): Promise<number> => {
    const antes = stats.chaves.size;
    for (let skip = 0; skip < 50_000; skip += 50) {
      let corpo: unknown;
      try {
        corpo = await chamarSieg("/api/v1/baixar-xmls", {
          // A documentação da SIEG tem duas versões com nomes diferentes
          // (TipoXml/XmlType, BaixarEventos/Downloadevent); mandamos os dois.
          corpo: {
            TipoXml: TIPOS_XML[tipo],
            XmlType: TIPOS_XML[tipo],
            Take: 50,
            Skip: skip,
            ...filtro,
            // Eventos vêm junto para marcar as notas canceladas.
            BaixarEventos: true,
            Downloadevent: true,
          },
        });
      } catch (error) {
        // Fim da lista ou mês sem notas: a SIEG costuma responder 404.
        if (error instanceof ErroSieg && error.status === 404) {
          if (primeiro && skip === 0) diagnostico = error.message.slice(0, 300);
          break;
        }
        // Filtro alternativo recusado pela SIEG: só não ajuda.
        if (!primeiro && error instanceof ErroSieg && error.status === 400) break;
        throw error;
      }
      const todos = extrairArquivos(corpo);
      const xmls = todos.filter((a) => a.tipo === "xml");
      stats.arquivos += todos.length;
      stats.xmls += xmls.length;
      if (primeiro && skip === 0 && xmls.length === 0) diagnostico = descreverResposta(corpo);
      paginas++;
      let notasPagina = 0;
      for (const a of xmls) {
        const r = await gravarResumo(a.conteudo.toString("utf8"), documento, papel, mes, tipo, canceladas, stats.chaves);
        if (r === "nota") notasPagina++;
        else if (r === "evento") stats.eventos++;
        else stats.naoReconhecidos++;
      }
      if (primeiro && skip === 0 && notasPagina === 0 && xmls.length > 0) {
        diagnostico = `${xmls.length} XML(s) recebidos, nenhum reconhecido como nota. ${descreverResposta(corpo)}`;
      }
      gravadas = stats.chaves.size;
      await prisma.siegBuscaNotas.update({ where: { id: buscaId }, data: { paginas, notas: gravadas } });
      // Take=50 vale para as notas; os eventos vêm a mais.
      if (notasPagina < 50) break;
    }
    return stats.chaves.size - antes;
  };

  try {
    const cnpj = papel === "emitente" ? { CnpjEmit: documento } : { CnpjDest: documento };
    porFiltro.push(`emissão: ${await percorrer({ DataEmissaoInicio: inicio, DataEmissaoFim: fim, ...cnpj }, true)}`);

    // NFS-e: a contagem da SIEG às vezes passa muito do que o download por data
    // de emissão entrega (visto em produção: 31 contadas, 1 entregue). Tenta
    // por data de envio à SIEG e, nas recebidas, pelo CNPJ como tomador.
    if (tipo === "nfse") {
      const contagem = await prisma.siegContagem.findUnique({ where: { documento_mes_papel: { documento, mes, papel } } });
      const contadas = contagem?.nfse ?? 0;
      if (stats.chaves.size < contadas) {
        porFiltro.push(`envio à SIEG: ${await percorrer({ DataUploadInicio: inicio, DataUploadFim: fim, ...cnpj }, false)}`);
      }
      if (papel === "destinatario" && stats.chaves.size < contadas) {
        porFiltro.push(
          `tomador: ${await percorrer({ DataEmissaoInicio: inicio, DataEmissaoFim: fim, CnpjTom: documento }, false)}`,
        );
      }
    }
    if (canceladas.size) {
      await prisma.siegNota.updateMany({ where: { chave: { in: [...canceladas] } }, data: { cancelada: true } });
    }
    await prisma.siegBuscaNotas.update({
      where: { id: buscaId },
      data: {
        situacao: "concluida",
        paginas,
        notas: gravadas,
        erro:
          gravadas === 0 && diagnostico
            ? `Resposta da SIEG: ${diagnostico}`.slice(0, 1000)
            : await avisoIncompleto(documento, mes, tipo, papel, stats, paginas, porFiltro),
        concluidaEm: new Date(),
      },
    });
  } catch (error) {
    await prisma.siegBuscaNotas.update({
      where: { id: buscaId },
      data: {
        situacao: "erro",
        paginas,
        notas: gravadas,
        erro: (error instanceof Error ? error.message : String(error))
          .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
          .slice(0, 500),
        concluidaEm: new Date(),
      },
    });
  }
}

export async function iniciarCapturaNotas(documento: string, mes: string, tipo: TipoNota, papel: Papel) {
  const chave = `${documento}|${mes}|${tipo}|${papel}`;
  if (buscasEmAndamento.has(chave)) {
    return prisma.siegBuscaNotas.findFirst({
      where: { documento, mes, tipo, papel, situacao: "andamento" },
      orderBy: { iniciadaEm: "desc" },
    });
  }
  const busca = await prisma.siegBuscaNotas.create({ data: { documento, mes, tipo, papel, situacao: "andamento" } });
  buscasEmAndamento.add(chave);
  void capturarNotas(busca.id, documento, mes, tipo, papel).finally(() => buscasEmAndamento.delete(chave));
  return busca;
}

/** Mesma captura, mas aguardando o fim (usada pela captura noturna, uma por vez). */
export async function capturarNotasAgora(documento: string, mes: string, tipo: TipoNota, papel: Papel) {
  const chave = `${documento}|${mes}|${tipo}|${papel}`;
  if (buscasEmAndamento.has(chave)) return null;
  const busca = await prisma.siegBuscaNotas.create({ data: { documento, mes, tipo, papel, situacao: "andamento" } });
  buscasEmAndamento.add(chave);
  try {
    await capturarNotas(busca.id, documento, mes, tipo, papel);
  } finally {
    buscasEmAndamento.delete(chave);
  }
  return prisma.siegBuscaNotas.findUnique({ where: { id: busca.id } });
}

/** Ao reiniciar o servidor, buscas que estavam "em andamento" morreram junto. */
export async function encerrarBuscasOrfas(): Promise<void> {
  await prisma.siegBuscaNotas.updateMany({
    where: { situacao: "andamento" },
    data: { situacao: "erro", erro: "Interrompida (o servidor reiniciou). Busque de novo.", concluidaEm: new Date() },
  });
}

// ------------------------------------------------------- uma nota (sob demanda)

async function xmlDaNota(chave: string, tipo: TipoNota): Promise<Buffer> {
  // Já capturada: usa a cópia guardada, sem gastar consulta na SIEG.
  const guardada = await prisma.siegNota.findUnique({ where: { chave }, select: { xml: true } });
  if (guardada?.xml) return gunzipSync(guardada.xml);
  const corpo = await chamarSieg("/api/v1/baixar-xml", {
    corpo: { ChaveXml: chave, TipoXml: TIPOS_XML[tipo], BaixarEventos: false },
  });
  const xml = extrairArquivos(corpo).find((a) => a.tipo === "xml");
  if (!xml) throw new Error("A SIEG não devolveu o XML desta nota");
  return xml.conteudo;
}

export async function baixarXmlNota(chave: string): Promise<{ nome: string; conteudo: Buffer }> {
  const nota = await prisma.siegNota.findUnique({ where: { chave } });
  const tipo = (nota?.tipo as TipoNota | undefined) ?? "nfe";
  return { nome: `${chave}.xml`, conteudo: await xmlDaNota(chave, tipo) };
}

export async function gerarDanfeNota(chave: string): Promise<{ nome: string; conteudo: Buffer }> {
  const nota = await prisma.siegNota.findUnique({ where: { chave } });
  const tipo = (nota?.tipo as TipoNota | undefined) ?? "nfe";
  const xml = await xmlDaNota(chave, tipo);
  const base64 = xml.toString("base64");
  // A doc diz só "Arquivo XML em Base 64": tenta como texto JSON e, se a SIEG
  // recusar o formato, como objeto { Xml }.
  let corpo: unknown;
  try {
    corpo = await chamarSieg("/api/v1/gerarDanfeViaXml", { corpo: base64 });
  } catch (error) {
    if (!(error instanceof ErroSieg) || (error.status !== 400 && error.status !== 415)) throw error;
    corpo = await chamarSieg("/api/v1/gerarDanfeViaXml", { corpo: { Xml: base64 } });
  }
  const pdf = extrairArquivos(corpo).find((a) => a.tipo === "pdf");
  if (!pdf) throw new Error("A SIEG não devolveu o PDF (DANFE) desta nota");
  return { nome: `${chave}.pdf`, conteudo: pdf.conteudo };
}

export interface EventoNota {
  tipo: number | null;
  descricao: string;
  protocolo: string | null;
  data: string | null;
}

const NOME_EVENTO: Record<string, string> = {
  "110110": "Carta de correção",
  "110111": "Cancelamento",
  "110112": "Cancelamento por substituição",
  "210200": "Confirmação da operação (destinatário)",
  "210210": "Ciência da operação (destinatário)",
  "210220": "Desconhecimento da operação (destinatário)",
  "210240": "Operação não realizada (destinatário)",
  "101101": "Cancelamento da NFS-e",
  "105102": "Cancelamento da NFS-e por substituição",
  "610601": "Cancelamento do CT-e",
  "790700": "Averbação para exportação",
};

/**
 * Eventos da nota (cancelamento, carta de correção, manifestação...). Vêm junto
 * com o XML da nota (baixar-xml com BaixarEventos) numa chamada só; a rota
 * baixar-eventos exige o tipo do evento ("TipoEvento: Certifique-se de informar
 * o evento", 400 visto em produção), então fica só de reserva.
 */
export async function eventosNota(chave: string): Promise<EventoNota[]> {
  const nota = await prisma.siegNota.findUnique({ where: { chave }, select: { tipo: true } });
  const tipo = (nota?.tipo as TipoNota | undefined) ?? "nfe";
  let corpo: unknown;
  try {
    corpo = await chamarSieg("/api/v1/baixar-xml", {
      corpo: { ChaveXml: chave, TipoXml: TIPOS_XML[tipo], XmlType: TIPOS_XML[tipo], BaixarEventos: true, Downloadevent: true },
    });
  } catch (error) {
    if (error instanceof ErroSieg && error.status === 404) return [];
    throw error;
  }
  const eventos: EventoNota[] = [];
  for (const a of extrairArquivos(corpo)) {
    if (a.tipo !== "xml") continue;
    const xml = a.conteudo.toString("utf8");
    const r = resumirXml(xml);
    if (!r?.ehEvento) continue;
    const codigo = r.tipoEvento ?? null;
    eventos.push({
      tipo: codigo ? Number(codigo) : null,
      descricao: (codigo && NOME_EVENTO[codigo]) || r.naturezaOperacao || "Evento",
      protocolo: /<(?:[\w-]+:)?nProt>(\d+)</.exec(xml)?.[1] ?? null,
      data: r.emissao?.toISOString() ?? null,
    });
  }
  return eventos.sort((a, b) => (a.data ?? "").localeCompare(b.data ?? ""));
}

/**
 * ZIP com os XMLs guardados de uma empresa num mês (para importar na
 * Domínio). Pastas: emitidas/ e recebidas/, um arquivo por chave.
 */
export async function zipXmlsMes(documento: string, mes: string): Promise<{ nome: string; conteudo: Buffer; total: number }> {
  const notas = await prisma.siegNota.findMany({
    where: { documentoEmpresa: documento, mes, xml: { not: null } },
    select: { chave: true, papel: true, tipo: true, xml: true },
    orderBy: [{ papel: "asc" }, { emissao: "asc" }],
  });
  const arquivos = notas.map((n) => ({
    nome: `${n.papel === "emitente" ? "emitidas" : "recebidas"}/${n.tipo}-${n.chave}.xml`,
    conteudo: gunzipSync(n.xml!),
  }));
  return { nome: `xmls-${documento}-${mes}.zip`, conteudo: montarZip(arquivos), total: arquivos.length };
}

// -------------------------------------------------------------- relatórios

export const RELATORIOS = {
  padrao: { codigo: 0, nome: "Padrão", tiposXml: [1, 2, 3, 4, 5] },
  monofasico: { codigo: 1, nome: "Monofásico (PIS/COFINS)", tiposXml: [1, 4] },
  basico: { codigo: 2, nome: "Relatório básico", tiposXml: [1, 4] },
  produtos: { codigo: 3, nome: "Detalhamento de produtos", tiposXml: [1, 4] },
  cte: { codigo: 4, nome: "CT-e", tiposXml: [2] },
  nfse: { codigo: 5, nome: "NFS-e", tiposXml: [3] },
} as const;
export type TipoRelatorio = keyof typeof RELATORIOS;

export async function gerarRelatorio(
  documento: string,
  mes: string,
  relatorio: TipoRelatorio,
  tipo: TipoNota,
): Promise<ArquivoSieg> {
  const [ano, m] = mes.split("-").map(Number) as [number, number];
  const corpo = await chamarSieg<{ UrlDownload?: string }>("/api/v1/relatorios-pre-configurados", {
    // A API real valida os nomes em português (TipoXml, Mes, Ano -- erro 400
    // visto em produção em 04/11/2026), diferente do Swagger (XmlType, Month,
    // Year). Mandamos os dois; campos a mais são ignorados.
    corpo: {
      Cnpj: documento,
      TipoDownload: RELATORIOS[relatorio].codigo,
      TipoXml: TIPOS_XML[tipo],
      Mes: m,
      Ano: ano,
      TypeXmlDownloadReport: RELATORIOS[relatorio].codigo,
      XmlType: TIPOS_XML[tipo],
      Month: m,
      Year: ano,
    },
  });
  // A doc fala em base64 e o Swagger em UrlDownload: aceita os dois.
  if (corpo && typeof corpo === "object" && typeof corpo.UrlDownload === "string" && corpo.UrlDownload.startsWith("http")) {
    const r = await fetch(corpo.UrlDownload, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Não foi possível baixar o relatório da SIEG (HTTP ${r.status})`);
    const bin = Buffer.from(await r.arrayBuffer());
    return { nome: `relatorio-${relatorio}-${documento}-${mes}.xlsx`, conteudo: bin, tipo: "planilha" };
  }
  const arquivo = extrairArquivos(corpo)[0];
  if (!arquivo) throw new Error("A SIEG não devolveu o arquivo do relatório (talvez não haja notas nesse mês)");
  const ext = arquivo.nome.split(".").pop() ?? "xlsx";
  return { ...arquivo, nome: `relatorio-${relatorio}-${documento}-${mes}.${ext}` };
}

// -------------------------------------------------------- status do certificado

export async function atualizarStatusCertificado(id: string): Promise<{ status: string | null; ultimaConsulta: Date | null }> {
  const corpo = await chamarSieg<{ Data?: { Status?: string; UltimaConsulta?: string } }>("/api/v1/status", {
    query: { id },
  });
  const status = corpo?.Data?.Status ?? null;
  const ultimaConsulta = corpo?.Data?.UltimaConsulta ? new Date(corpo.Data.UltimaConsulta) : null;
  await prisma.siegEmpresa.update({ where: { id }, data: { statusSieg: status, ultimaConsultaSieg: ultimaConsulta } });
  return { status, ultimaConsulta };
}
