// Dados de uma nota para o DANFE/visualização gerados no próprio sistema, a
// partir do XML guardado. A SIEG só gera o DANFE com permissão de ESCRITA
// ("Nível de acesso requerido: Write", visto em produção em 05/11/2026), e a
// integração é somente leitura -- então o documento é montado aqui.
import { xmlUtil } from "./arquivos.js";

const { tag, primeiraTag, texto, numero, digitos, docDe } = xmlUtil;

export interface Parte {
  documento: string | null;
  nome: string | null;
  fantasia: string | null;
  ie: string | null;
  im: string | null;
  endereco: string | null;
  municipio: string | null;
  uf: string | null;
  cep: string | null;
  fone: string | null;
}

export interface ItemNota {
  numero: number;
  codigo: string | null;
  descricao: string | null;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number | null;
  valorUnitario: number | null;
  valorTotal: number | null;
  desconto: number | null;
  baseIcms: number | null;
  aliquotaIcms: number | null;
  valorIcms: number | null;
  valorIpi: number | null;
}

export interface DetalheNota {
  tipo: "nfe" | "nfce" | "nfse" | "cte" | "cfe" | "outro";
  modelo: string | null;
  chave: string | null;
  numero: string | null;
  serie: string | null;
  emissao: string | null;
  saidaEntrada: "entrada" | "saida" | null;
  naturezaOperacao: string | null;
  protocolo: { numero: string | null; data: string | null } | null;
  emitente: Parte;
  destinatario: Parte;
  itens: ItemNota[];
  totais: Record<string, number | null>;
  transporte: { modalidade: string | null; transportadora: string | null; documento: string | null } | null;
  duplicatas: { numero: string | null; vencimento: string | null; valor: number | null }[];
  servico: { descricao: string | null; codigo: string | null; municipio: string | null } | null;
  informacoes: string | null;
}

const MOD_FRETE: Record<string, string> = {
  "0": "Por conta do emitente",
  "1": "Por conta do destinatário",
  "2": "Por conta de terceiros",
  "3": "Próprio do remetente",
  "4": "Próprio do destinatário",
  "9": "Sem frete",
};

function parte(bloco: string | null, enderTag: string): Parte {
  const end = tag(bloco ?? "", enderTag) ?? tag(bloco ?? "", "end") ?? tag(bloco ?? "", "endNac") ?? tag(bloco ?? "", "Endereco");
  const logradouro = [primeiraTag(end, ["xLgr", "Endereco"]), primeiraTag(end, ["nro", "Numero"]), primeiraTag(end, ["xCpl", "Complemento"]), primeiraTag(end, ["xBairro", "Bairro"])]
    .map(texto)
    .filter(Boolean)
    .join(", ");
  return {
    documento: docDe(bloco),
    nome: texto(primeiraTag(bloco, ["xNome", "RazaoSocial"])),
    fantasia: texto(primeiraTag(bloco, ["xFant", "NomeFantasia"])),
    ie: texto(primeiraTag(bloco, ["IE"])),
    im: texto(primeiraTag(bloco, ["IM", "InscricaoMunicipal"])),
    endereco: logradouro || null,
    municipio: texto(primeiraTag(end, ["xMun"])),
    uf: texto(primeiraTag(end, ["UF", "Uf"])),
    cep: digitos(primeiraTag(end, ["CEP", "Cep"])),
    fone: digitos(primeiraTag(bloco, ["fone", "Telefone"])),
  };
}

function itensNfe(xml: string): ItemNota[] {
  const itens: ItemNota[] = [];
  const re = /<(?:[\w-]+:)?det\b[^>]*nItem="(\d+)"[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?det>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const corpo = m[2]!;
    const prod = tag(corpo, "prod");
    const icms = tag(corpo, "ICMS");
    itens.push({
      numero: Number(m[1]),
      codigo: texto(primeiraTag(prod, ["cProd"])),
      descricao: texto(primeiraTag(prod, ["xProd"])),
      ncm: primeiraTag(prod, ["NCM"]),
      cfop: primeiraTag(prod, ["CFOP"]),
      unidade: texto(primeiraTag(prod, ["uCom"])),
      quantidade: numero(primeiraTag(prod, ["qCom"])),
      valorUnitario: numero(primeiraTag(prod, ["vUnCom"])),
      valorTotal: numero(primeiraTag(prod, ["vProd"])),
      desconto: numero(primeiraTag(prod, ["vDesc"])),
      baseIcms: numero(primeiraTag(icms, ["vBC"])),
      aliquotaIcms: numero(primeiraTag(icms, ["pICMS"])),
      valorIcms: numero(primeiraTag(icms, ["vICMS"])),
      valorIpi: numero(primeiraTag(tag(corpo, "IPI"), ["vIPI"])),
    });
  }
  return itens;
}

export function detalharNota(xml: string, tipoGuardado: string | null): DetalheNota {
  const vazio: Parte = { documento: null, nome: null, fantasia: null, ie: null, im: null, endereco: null, municipio: null, uf: null, cep: null, fone: null };

  // NF-e / NFC-e
  if (/<(?:[\w-]+:)?infNFe[\s>]/.test(xml)) {
    const ide = tag(xml, "ide");
    const tot = tag(xml, "ICMSTot");
    const transp = tag(xml, "transp");
    const transporta = tag(transp ?? "", "transporta");
    const prot = tag(xml, "infProt");
    const modelo = primeiraTag(ide, ["mod"]);
    const campos = ["vBC", "vICMS", "vBCST", "vST", "vProd", "vFrete", "vSeg", "vDesc", "vIPI", "vPIS", "vCOFINS", "vOutro", "vNF", "vTotTrib"];
    const dups: DetalheNota["duplicatas"] = [];
    const reDup = /<(?:[\w-]+:)?dup>([\s\S]*?)<\/(?:[\w-]+:)?dup>/g;
    for (let m = reDup.exec(xml); m; m = reDup.exec(xml)) {
      dups.push({ numero: primeiraTag(m[1]!, ["nDup"]), vencimento: primeiraTag(m[1]!, ["dVenc"]), valor: numero(primeiraTag(m[1]!, ["vDup"])) });
    }
    return {
      tipo: modelo === "65" ? "nfce" : "nfe",
      modelo,
      chave: /Id="NFe(\d{44})"/.exec(xml)?.[1] ?? digitos(primeiraTag(prot, ["chNFe"])),
      numero: primeiraTag(ide, ["nNF"]),
      serie: primeiraTag(ide, ["serie"]),
      emissao: primeiraTag(ide, ["dhEmi", "dEmi"]),
      saidaEntrada: primeiraTag(ide, ["tpNF"]) === "0" ? "entrada" : "saida",
      naturezaOperacao: texto(primeiraTag(ide, ["natOp"])),
      protocolo: prot ? { numero: primeiraTag(prot, ["nProt"]), data: primeiraTag(prot, ["dhRecbto"]) } : null,
      emitente: parte(tag(xml, "emit"), "enderEmit"),
      destinatario: tag(xml, "dest") ? parte(tag(xml, "dest"), "enderDest") : vazio,
      itens: itensNfe(xml),
      totais: Object.fromEntries(campos.map((c) => [c, numero(primeiraTag(tot, [c]))])),
      transporte: transp
        ? {
            modalidade: MOD_FRETE[primeiraTag(transp, ["modFrete"]) ?? ""] ?? null,
            transportadora: texto(primeiraTag(transporta, ["xNome"])),
            documento: docDe(transporta),
          }
        : null,
      duplicatas: dups,
      servico: null,
      informacoes: texto(primeiraTag(tag(xml, "infAdic"), ["infCpl"])),
    };
  }

  // NFS-e (nacional e ABRASF)
  if (/nfse|InfNfse|infNFSe/i.test(xml)) {
    const emit = tag(xml, "emit") ?? tag(xml, "PrestadorServico") ?? tag(xml, "Prestador");
    const toma = tag(xml, "toma") ?? tag(xml, "TomadorServico") ?? tag(xml, "Tomador");
    return {
      tipo: "nfse",
      modelo: null,
      chave: digitos(/Id="NFS(\d{40,60})"/.exec(xml)?.[1] ?? null),
      numero: primeiraTag(xml, ["nNFSe", "Numero"]),
      serie: primeiraTag(xml, ["serie", "Serie"]),
      emissao: primeiraTag(xml, ["dhEmi", "DataEmissao", "dhProc"]),
      saidaEntrada: null,
      naturezaOperacao: null,
      protocolo: null,
      emitente: parte(emit, "enderNac"),
      destinatario: toma ? parte(toma, "end") : vazio,
      itens: [],
      totais: {
        vServ: numero(primeiraTag(xml, ["vServ", "ValorServicos"])),
        vISS: numero(primeiraTag(xml, ["vISSQN", "ValorIss"])),
        vRet: numero(primeiraTag(xml, ["vTotalRet", "ValorIssRetido"])),
        vLiq: numero(primeiraTag(xml, ["vLiq", "ValorLiquidoNfse"])),
      },
      transporte: null,
      duplicatas: [],
      servico: {
        descricao: texto(primeiraTag(xml, ["xDescServ", "Discriminacao"])),
        codigo: primeiraTag(xml, ["cTribNac", "ItemListaServico", "CodigoTributacaoMunicipio"]),
        municipio: texto(primeiraTag(xml, ["xLocPrestacao", "xLocIncid"])),
      },
      informacoes: texto(primeiraTag(xml, ["xInfComp", "OutrasInformacoes"])),
    };
  }

  // CT-e / CF-e / outros: o básico.
  const ide = tag(xml, "ide");
  return {
    tipo: /infCte/.test(xml) ? "cte" : /infCFe/.test(xml) ? "cfe" : (tipoGuardado as DetalheNota["tipo"]) ?? "outro",
    modelo: primeiraTag(ide, ["mod"]),
    chave: /Id="(?:CTe|CFe)(\d{44})"/.exec(xml)?.[1] ?? null,
    numero: primeiraTag(ide, ["nCT", "nCFe"]),
    serie: primeiraTag(ide, ["serie"]),
    emissao: primeiraTag(ide, ["dhEmi", "dEmi"]),
    saidaEntrada: null,
    naturezaOperacao: texto(primeiraTag(ide, ["natOp"])),
    protocolo: null,
    emitente: parte(tag(xml, "emit"), "enderEmit"),
    destinatario: tag(xml, "dest") ? parte(tag(xml, "dest"), "enderDest") : vazio,
    itens: [],
    totais: { vNF: numero(primeiraTag(xml, ["vTPrest", "vCFe", "vNF"])) },
    transporte: null,
    duplicatas: [],
    servico: null,
    informacoes: texto(primeiraTag(tag(xml, "compl") ?? tag(xml, "infAdic"), ["xObs", "infCpl"])),
  };
}
