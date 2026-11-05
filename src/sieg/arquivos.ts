// Leitura dos arquivos que a SIEG devolve: ZIP em base64 (baixar em lote),
// XML em base64 ou texto, PDF em base64 (DANFE) e planilhas (relatórios).
// Sem dependências novas: o ZIP é lido pelo diretório central + zlib.
import { crc32, deflateRawSync, gunzipSync, inflateRawSync } from "node:zlib";

export interface ArquivoSieg {
  nome: string;
  conteudo: Buffer;
  tipo: "xml" | "pdf" | "zip" | "planilha" | "outro";
}

/** Lê as entradas de um arquivo ZIP (método "stored" ou "deflate"). */
export function lerZip(zip: Buffer): { nome: string; conteudo: Buffer }[] {
  // Fim do diretório central: assinatura 0x06054b50 nos últimos ~64 KB.
  let fim = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      fim = i;
      break;
    }
  }
  if (fim < 0) throw new Error("Arquivo ZIP inválido (sem diretório central)");
  const total = zip.readUInt16LE(fim + 10);
  let p = zip.readUInt32LE(fim + 16);
  const saida: { nome: string; conteudo: Buffer }[] = [];
  for (let n = 0; n < total; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = zip.readUInt16LE(p + 10);
    const tamanhoComprimido = zip.readUInt32LE(p + 20);
    const tamNome = zip.readUInt16LE(p + 28);
    const tamExtra = zip.readUInt16LE(p + 30);
    const tamComentario = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    const nome = zip.subarray(p + 46, p + 46 + tamNome).toString("utf8");
    p += 46 + tamNome + tamExtra + tamComentario;
    if (nome.endsWith("/")) continue; // pasta
    const inicioDados = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const dados = zip.subarray(inicioDados, inicioDados + tamanhoComprimido);
    const conteudo = metodo === 0 ? Buffer.from(dados) : metodo === 8 ? inflateRawSync(dados) : null;
    if (conteudo) saida.push({ nome, conteudo });
  }
  return saida;
}

/**
 * XML em UTF-16 (padrão do Windows/.NET: "<\0?\0x\0m\0l\0", com ou sem BOM)
 * vira UTF-8; o BOM do UTF-8 sai. Visto em produção em 05/11/2026: a SIEG
 * devolve alguns XMLs em UTF-16 e, lidos como UTF-8, nada era reconhecido.
 */
export function paraUtf8(b: Buffer): Buffer {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return Buffer.from(b.subarray(2).toString("utf16le"), "utf8");
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const le = Buffer.from(b.subarray(2));
    le.swap16();
    return Buffer.from(le.toString("utf16le"), "utf8");
  }
  // Sem BOM: texto ASCII em UTF-16LE tem zero em toda posição ímpar do início.
  if (b.length >= 8 && b[1] === 0 && b[3] === 0 && b[5] === 0 && b[0] !== 0) {
    return Buffer.from(b.toString("utf16le"), "utf8");
  }
  if (b.length >= 8 && b[0] === 0 && b[2] === 0 && b[4] === 0 && b[1] !== 0) {
    const le = Buffer.from(b.subarray(0, b.length - (b.length % 2)));
    le.swap16();
    return Buffer.from(le.toString("utf16le"), "utf8");
  }
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3);
  return b;
}

/** Normaliza o arquivo: se for XML (inclusive UTF-16), devolve em UTF-8. */
function normalizar(b: Buffer): { conteudo: Buffer; tipo: ArquivoSieg["tipo"] } {
  if (b[0] === 0x50 && b[1] === 0x4b) return { conteudo: b, tipo: "zip" };
  const utf8 = paraUtf8(b);
  const tipo = classificar(utf8);
  return { conteudo: tipo === "xml" ? utf8 : b, tipo };
}

function classificar(b: Buffer): ArquivoSieg["tipo"] {
  const inicio = b.subarray(0, 8).toString("latin1").replace(/^﻿|^\xEF\xBB\xBF/, "").trimStart();
  if (inicio.startsWith("<")) return "xml";
  if (inicio.startsWith("%PDF")) return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b) return "zip";
  return "outro";
}

const pareceBase64 = (s: string) => s.length >= 16 && /^[A-Za-z0-9+/=\r\n]+$/.test(s.slice(0, 400));

/**
 * Procura arquivos em qualquer parte da resposta da SIEG (string solta,
 * campo Data/Xml/Arquivo, lista...), decodificando base64 e abrindo ZIPs.
 * A documentação muda de formato de rota para rota, então isto é tolerante.
 */
export function extrairArquivos(corpo: unknown): ArquivoSieg[] {
  const arquivos: ArquivoSieg[] = [];
  const visitar = (valor: unknown, nome: string, profundidade: number) => {
    if (profundidade > 6 || valor === null || valor === undefined) return;
    // Resposta binária (a SIEG manda o ZIP direto, sem base64 nem JSON).
    if (Buffer.isBuffer(valor) || typeof valor === "string") {
      let bin: Buffer;
      if (Buffer.isBuffer(valor)) {
        bin = valor;
      } else {
        const texto = valor.trim();
        if (texto.startsWith("<")) {
          arquivos.push({ nome: `${nome}.xml`, conteudo: Buffer.from(texto, "utf8"), tipo: "xml" });
          return;
        }
        if (!pareceBase64(texto)) return;
        bin = Buffer.from(texto, "base64");
      }
      // Conteúdo compactado em gzip (1f 8b): abre antes de classificar.
      if (bin[0] === 0x1f && bin[1] === 0x8b) {
        try {
          bin = gunzipSync(bin);
        } catch {
          return;
        }
      }
      const normal = normalizar(bin);
      const tipo = normal.tipo;
      if (tipo === "xml") bin = normal.conteudo;
      if (tipo === "zip") {
        let entradas: { nome: string; conteudo: Buffer }[] = [];
        try {
          entradas = lerZip(bin);
        } catch {
          arquivos.push({ nome: `${nome}.zip`, conteudo: bin, tipo: "planilha" });
          return;
        }
        // XLSX também é um ZIP: se não tiver XML fiscal dentro, é planilha.
        const ehPlanilha = entradas.some((e) => e.nome.startsWith("xl/"));
        if (ehPlanilha) {
          arquivos.push({ nome: `${nome}.xlsx`, conteudo: bin, tipo: "planilha" });
          return;
        }
        for (const e of entradas) arquivos.push({ nome: e.nome, ...normalizar(e.conteudo) });
        return;
      }
      if (tipo !== "outro") arquivos.push({ nome: `${nome}.${tipo}`, conteudo: bin, tipo });
      return;
    }
    if (Array.isArray(valor)) {
      valor.forEach((v, i) => visitar(v, `${nome}-${i + 1}`, profundidade + 1));
      return;
    }
    if (typeof valor === "object") {
      for (const [k, v] of Object.entries(valor as Record<string, unknown>)) visitar(v, k, profundidade + 1);
    }
  };
  visitar(corpo, "arquivo", 0);
  return arquivos;
}

// ---------------------------------------------------------------------------
// Resumo de um documento fiscal a partir do XML (NF-e, NFC-e, CT-e, CF-e e
// NFS-e nos padrões mais comuns: nacional, ABRASF e similares).
// ---------------------------------------------------------------------------

export interface ResumoNota {
  chave: string;
  tipo: "nfe" | "nfce" | "cte" | "cfe" | "nfse";
  emissao: Date | null;
  numero: string | null;
  serie: string | null;
  emitenteDocumento: string | null;
  emitenteNome: string | null;
  destinatarioDocumento: string | null;
  destinatarioNome: string | null;
  valor: number | null;
  naturezaOperacao: string | null;
  /** Evento (cancelamento etc.), não uma nota. */
  ehEvento: boolean;
  /** Código do evento (tpEvento): 110111 = cancelamento. Só em eventos. */
  tipoEvento?: string | null;
}

export const EVENTO_CANCELAMENTO = "110111";
/** Cancelamentos (lista da doc do baixar-xmls): NF-e 110111/110112, NFS-e 101101/105102/105104, CT-e 610601. */
export const EVENTOS_CANCELAMENTO = new Set(["110111", "110112", "101101", "105102", "105104", "610601"]);

/** Conteúdo da primeira tag com esse nome (com ou sem prefixo de namespace). */
function tag(xml: string, nome: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${nome}>`, "i").exec(xml);
  return m ? m[1]!.trim() : null;
}
function primeiraTag(xml: string | null, nomes: string[]): string | null {
  if (!xml) return null;
  for (const n of nomes) {
    const v = tag(xml, n);
    if (v) return v;
  }
  return null;
}
const digitos = (v: string | null) => (v ? v.replace(/\D/g, "") || null : null);
const numero = (v: string | null) => {
  if (!v) return null;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
function data(v: string | null): Date | null {
  if (!v) return null;
  // CF-e usa AAAAMMDD
  const t = /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}
const texto = (v: string | null) =>
  v
    ? v
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .trim() || null
    : null;
const docDe = (bloco: string | null) => digitos(primeiraTag(bloco, ["CNPJ", "Cnpj", "CPF", "Cpf"]));

export function resumirXml(xml: string): ResumoNota | null {
  const ehEvento =
    /<(?:[\w-]+:)?(procEventoNFe|procEventoCTe|evento|eventoCTe|pedRegEvento|infPedReg)[\s>]/.test(xml) &&
    !/<(?:[\w-]+:)?(infNFe|infNFSe|infCte)[\s>]/.test(xml);
  if (ehEvento) {
    const chave = digitos(primeiraTag(xml, ["chNFe", "chCTe", "chNFSe"]));
    return chave
      ? {
          chave,
          tipo: "nfe",
          emissao: data(primeiraTag(xml, ["dhEvento"])),
          numero: null,
          serie: null,
          emitenteDocumento: null,
          emitenteNome: null,
          destinatarioDocumento: null,
          destinatarioNome: null,
          valor: null,
          naturezaOperacao: texto(primeiraTag(xml, ["descEvento", "xEvento"])),
          ehEvento: true,
          tipoEvento: primeiraTag(xml, ["tpEvento"]) ?? /<(?:[\w-]+:)?e(\d{6})[\s>]/.exec(xml)?.[1] ?? null,
        }
      : null;
  }

  // NF-e / NFC-e
  const idNfe = /<(?:[\w-]+:)?infNFe[^>]*Id="NFe(\d{44})"/.exec(xml)?.[1];
  if (idNfe || /<(?:[\w-]+:)?infNFe[\s>]/.test(xml)) {
    const ide = tag(xml, "ide");
    const emit = tag(xml, "emit");
    const dest = tag(xml, "dest");
    const mod = primeiraTag(ide, ["mod"]);
    return {
      chave: idNfe ?? digitos(primeiraTag(xml, ["chNFe"])) ?? "",
      tipo: mod === "65" ? "nfce" : "nfe",
      emissao: data(primeiraTag(ide, ["dhEmi", "dEmi"])),
      numero: primeiraTag(ide, ["nNF"]),
      serie: primeiraTag(ide, ["serie"]),
      emitenteDocumento: docDe(emit),
      emitenteNome: texto(primeiraTag(emit, ["xNome"])),
      destinatarioDocumento: docDe(dest),
      destinatarioNome: texto(primeiraTag(dest, ["xNome"])),
      valor: numero(primeiraTag(tag(xml, "ICMSTot"), ["vNF"])),
      naturezaOperacao: texto(primeiraTag(ide, ["natOp"])),
      ehEvento: false,
    };
  }

  // CT-e
  const idCte = /<(?:[\w-]+:)?infCte[^>]*Id="CTe(\d{44})"/.exec(xml)?.[1];
  if (idCte || /<(?:[\w-]+:)?infCte[\s>]/.test(xml)) {
    const ide = tag(xml, "ide");
    const emit = tag(xml, "emit");
    const dest = tag(xml, "dest") ?? tag(xml, "toma") ?? tag(xml, "rem");
    return {
      chave: idCte ?? digitos(primeiraTag(xml, ["chCTe"])) ?? "",
      tipo: "cte",
      emissao: data(primeiraTag(ide, ["dhEmi"])),
      numero: primeiraTag(ide, ["nCT"]),
      serie: primeiraTag(ide, ["serie"]),
      emitenteDocumento: docDe(emit),
      emitenteNome: texto(primeiraTag(emit, ["xNome"])),
      destinatarioDocumento: docDe(dest),
      destinatarioNome: texto(primeiraTag(dest, ["xNome"])),
      valor: numero(primeiraTag(tag(xml, "vPrest"), ["vTPrest"])),
      naturezaOperacao: texto(primeiraTag(ide, ["natOp"])),
      ehEvento: false,
    };
  }

  // CF-e SAT
  const idCfe = /<(?:[\w-]+:)?infCFe[^>]*Id="CFe(\d{44})"/.exec(xml)?.[1];
  if (idCfe) {
    const ide = tag(xml, "ide");
    const emit = tag(xml, "emit");
    const dest = tag(xml, "dest");
    return {
      chave: idCfe,
      tipo: "cfe",
      emissao: data(primeiraTag(ide, ["dEmi"])),
      numero: primeiraTag(ide, ["nCFe"]),
      serie: primeiraTag(ide, ["nserieSAT"]),
      emitenteDocumento: docDe(emit),
      emitenteNome: texto(primeiraTag(emit, ["xNome", "xFant"])),
      destinatarioDocumento: docDe(dest),
      destinatarioNome: texto(primeiraTag(dest, ["xNome"])),
      valor: numero(primeiraTag(xml, ["vCFe"])),
      naturezaOperacao: null,
      ehEvento: false,
    };
  }

  // NFS-e (padrão nacional e ABRASF/municipais)
  if (/nfse|CompNfse|InfNfse|infNFSe|Nfse/i.test(xml)) {
    // Padrão nacional: <emit> tem CNPJ e nome; <prest> (dentro da DPS) às vezes só o CNPJ.
    const emitNacional = tag(xml, "emit");
    const prestador = tag(xml, "prest") ?? tag(xml, "PrestadorServico") ?? tag(xml, "Prestador") ?? emitNacional;
    const tomador = tag(xml, "toma") ?? tag(xml, "TomadorServico") ?? tag(xml, "Tomador");
    const numeroNota = primeiraTag(xml, ["nNFSe", "Numero", "NumeroNfse"]);
    const emitenteDocumento = docDe(emitNacional) ?? docDe(prestador);
    const chave =
      digitos(/Id="NFS(\d{40,60})"/.exec(xml)?.[1] ?? null) ??
      digitos(primeiraTag(xml, ["chNFSe", "ChaveAcesso"])) ??
      `nfse-${emitenteDocumento ?? "x"}-${numeroNota ?? Date.now()}`;
    return {
      chave,
      tipo: "nfse",
      emissao: data(primeiraTag(xml, ["dhEmi", "DataEmissao", "dhProc", "Competencia"])),
      numero: numeroNota,
      serie: primeiraTag(xml, ["serie", "Serie"]),
      emitenteDocumento,
      emitenteNome:
        texto(primeiraTag(emitNacional, ["xNome"])) ?? texto(primeiraTag(prestador, ["xNome", "RazaoSocial", "NomeFantasia"])),
      destinatarioDocumento: docDe(tomador),
      destinatarioNome: texto(primeiraTag(tomador, ["xNome", "RazaoSocial"])),
      valor: numero(primeiraTag(xml, ["vLiq", "vServ", "ValorLiquidoNfse", "ValorServicos"])),
      naturezaOperacao: texto(primeiraTag(xml, ["xDescServ", "Discriminacao"]))?.slice(0, 200) ?? null,
      ehEvento: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Monta um ZIP (deflate) com os arquivos dados -- usado para exportar os XMLs
 * do mês e importar na Domínio. Sem dependências: cabeçalhos locais +
 * diretório central, como o leitor acima.
 */
export function montarZip(arquivos: { nome: string; conteudo: Buffer }[]): Buffer {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let deslocamento = 0;
  for (const a of arquivos) {
    const nome = Buffer.from(a.nome, "utf8");
    const compactado = deflateRawSync(a.conteudo);
    const crc = crc32(a.conteudo);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0, 10); // hora/data
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compactado.length, 18);
    local.writeUInt32LE(a.conteudo.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    partes.push(local, nome, compactado);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(0, 12);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compactado.length, 20);
    c.writeUInt32LE(a.conteudo.length, 24);
    c.writeUInt16LE(nome.length, 28);
    c.writeUInt32LE(deslocamento, 42);
    central.push(c, nome);
    deslocamento += local.length + nome.length + compactado.length;
  }
  const tamanhoCentral = central.reduce((s, b) => s + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);
  return Buffer.concat([...partes, ...central, fim]);
}

/**
 * Descrição curta de uma resposta da SIEG (formato, chaves, arquivos achados),
 * para diagnosticar quando uma busca termina sem nenhuma nota. Não inclui o
 * conteúdo das notas.
 */
export function descreverResposta(corpo: unknown): string {
  const tipoDe = (v: unknown) => (Array.isArray(v) ? `lista(${v.length})` : v === null ? "null" : typeof v);
  const partes: string[] = [`corpo: ${Buffer.isBuffer(corpo) ? `binário(${corpo.length} bytes)` : tipoDe(corpo)}`];
  if (typeof corpo === "string") partes.push(`início "${corpo.slice(0, 40)}"`);
  if (corpo && typeof corpo === "object" && !Array.isArray(corpo) && !Buffer.isBuffer(corpo)) {
    const o = corpo as Record<string, unknown>;
    partes.push(`chaves {${Object.entries(o).map(([k, v]) => `${k}: ${tipoDe(v)}`).join(", ")}}`);
    const msg = ["message", "Message", "ErrorMessage", "Mensagens"].map((k) => o[k]).find((v) => v && (typeof v === "string" || Array.isArray(v)));
    if (msg) partes.push(`mensagem "${String(msg).slice(0, 120)}"`);
  }
  const lista = Buffer.isBuffer(corpo)
    ? null
    : Array.isArray(corpo)
    ? corpo
    : ((corpo as Record<string, unknown> | null)?.["data"] ?? (corpo as Record<string, unknown> | null)?.["Data"]);
  if (Array.isArray(lista) && lista.length) {
    const p = lista[0];
    partes.push(
      `1º item: ${tipoDe(p)}${
        typeof p === "string"
          ? ` de ${p.length} caracteres, início "${p.slice(0, 12)}"`
          : p && typeof p === "object"
            ? ` {${Object.keys(p).slice(0, 12).join(", ")}}`
            : ""
      }`,
    );
  }
  const arquivos = extrairArquivos(corpo);
  const porTipo = arquivos.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.tipo]: (acc[a.tipo] ?? 0) + 1 }), {});
  partes.push(`arquivos achados: ${arquivos.length ? JSON.stringify(porTipo) : "nenhum"}`);
  const xml = arquivos.find((a) => a.tipo === "xml");
  if (xml) partes.push(`1º XML começa com "${xml.conteudo.subarray(0, 80).toString("utf8").replace(/\s+/g, " ")}"`);
  // Sem bytes nulos/de controle: o Postgres recusa \0 em texto.
  return partes
    .join(" · ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 900);
}
