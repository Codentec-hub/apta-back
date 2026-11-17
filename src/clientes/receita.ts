// Consulta de CNPJ na Receita via BrasilAPI (pública, sem chave), normalizada
// para o cadastro da empresa. CNPJ recém-aberto às vezes ainda não está na
// BrasilAPI: aí tenta o CNPJ.ws (público, 3 consultas/min), que também traz a
// inscrição estadual. Usada pela tela ("Buscar na Receita") e pelo
// preenchimento automático dos cadastros (clientes/completar.ts).

const URL_BRASILAPI = "https://brasilapi.com.br/api/cnpj/v1/";
const URL_CNPJWS = "https://publica.cnpj.ws/cnpj/";
const CABECALHOS = { "User-Agent": "SistemaApta/1.0", Accept: "application/json" };

interface RespostaBrasilApi {
  razao_social?: string;
  nome_fantasia?: string | null;
  cnae_fiscal?: number | null;
  cnae_fiscal_descricao?: string | null;
  cnaes_secundarios?: { codigo: number; descricao: string }[] | null;
  cep?: string | null;
  logradouro?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  municipio?: string | null;
  uf?: string | null;
  data_inicio_atividade?: string | null;
  descricao_situacao_cadastral?: string | null;
  opcao_pelo_simples?: boolean | null;
  opcao_pelo_mei?: boolean | null;
  qsa?: { nome_socio?: string; qualificacao_socio?: string }[] | null;
}

// 4721102 → "4721-1/02"
function formatarCnae(codigo: number | null | undefined): string | null {
  if (!codigo) return null;
  const d = String(codigo).padStart(7, "0");
  return `${d.slice(0, 4)}-${d.slice(4, 5)}/${d.slice(5)}`;
}

// "FORTALEZA" → "Fortaleza"; mantém preposições minúsculas.
function nomeProprio(texto: string | null | undefined): string | null {
  if (!texto) return null;
  return texto
    .toLowerCase()
    .split(/\s+/)
    .map((p, i) => (i > 0 && ["de", "da", "do", "das", "dos", "e"].includes(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(" ");
}

export interface DadosReceita {
  razaoSocial: string | null;
  nomeFantasia: string | null;
  situacaoCadastral: string | null;
  dataAbertura: string | null;
  cnaePrincipal: string | null;
  cnaeDescricao: string | null;
  cnaesSecundarios: { codigo: string; descricao: string }[];
  cep: string | null;
  endereco: string | null;
  cidade: string | null;
  uf: string | null;
  simples: boolean;
  mei: boolean;
  socios: { nome: string; cargo: string | null; responsavelLegal: boolean }[];
  /** Só o CNPJ.ws traz; a BrasilAPI não tem IE. */
  inscricaoEstadual: string | null;
  fonte: "brasilapi" | "cnpjws";
}

export class ErroReceita extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502,
  ) {
    super(message);
  }
}

/** Normaliza a resposta da BrasilAPI. */
export function deBrasilApi(d: RespostaBrasilApi): DadosReceita {

  const endereco = [[d.logradouro, d.numero].filter(Boolean).join(", "), d.complemento, d.bairro]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" - ");

  // Sócio-administrador (ou administrador) é o responsável legal sugerido.
  const socios = (d.qsa ?? [])
    .filter((s) => s.nome_socio)
    .map((s) => ({
      nome: nomeProprio(s.nome_socio)!,
      cargo: s.qualificacao_socio ?? null,
      responsavelLegal: /administrador/i.test(s.qualificacao_socio ?? ""),
    }));

  return {
    razaoSocial: d.razao_social ?? null,
    nomeFantasia: d.nome_fantasia || null,
    situacaoCadastral: d.descricao_situacao_cadastral ?? null,
    dataAbertura: d.data_inicio_atividade ?? null,
    cnaePrincipal: formatarCnae(d.cnae_fiscal),
    cnaeDescricao: d.cnae_fiscal_descricao ?? null,
    cnaesSecundarios: (d.cnaes_secundarios ?? [])
      .filter((c) => c.codigo)
      .map((c) => ({ codigo: formatarCnae(c.codigo)!, descricao: c.descricao })),
    cep: d.cep ?? null,
    endereco: endereco || null,
    cidade: nomeProprio(d.municipio),
    uf: d.uf ?? null,
    simples: Boolean(d.opcao_pelo_simples),
    mei: Boolean(d.opcao_pelo_mei),
    socios,
    inscricaoEstadual: null,
    fonte: "brasilapi",
  };
}

interface RespostaCnpjWs {
  razao_social?: string;
  simples?: { simples?: string | null; mei?: string | null } | null;
  socios?: { nome?: string; qualificacao_socio?: { descricao?: string } | null }[] | null;
  estabelecimento?: {
    nome_fantasia?: string | null;
    situacao_cadastral?: string | null;
    data_inicio_atividade?: string | null;
    atividade_principal?: { subclasse?: string; descricao?: string } | null;
    atividades_secundarias?: { subclasse?: string; descricao?: string }[] | null;
    cep?: string | null;
    tipo_logradouro?: string | null;
    logradouro?: string | null;
    numero?: string | null;
    complemento?: string | null;
    bairro?: string | null;
    cidade?: { nome?: string } | null;
    estado?: { sigla?: string } | null;
    inscricoes_estaduais?: { inscricao_estadual?: string; ativo?: boolean; estado?: { sigla?: string } }[] | null;
  } | null;
}

/** Normaliza a resposta do CNPJ.ws para o mesmo formato. */
export function deCnpjWs(d: RespostaCnpjWs): DadosReceita {
  const e = d.estabelecimento ?? {};
  const rua = [e.tipo_logradouro, e.logradouro].filter(Boolean).join(" ");
  const endereco = [[rua, e.numero].filter(Boolean).join(", "), e.complemento, e.bairro]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" - ");
  const uf = e.estado?.sigla ?? null;
  const ies = (e.inscricoes_estaduais ?? []).filter((i) => i.inscricao_estadual && i.ativo !== false);
  const ie = ies.find((i) => i.estado?.sigla === uf) ?? ies[0];
  return {
    razaoSocial: d.razao_social ?? null,
    nomeFantasia: e.nome_fantasia || null,
    situacaoCadastral: e.situacao_cadastral ? e.situacao_cadastral.toUpperCase() : null,
    dataAbertura: e.data_inicio_atividade ?? null,
    cnaePrincipal: e.atividade_principal?.subclasse ?? null,
    cnaeDescricao: e.atividade_principal?.descricao ?? null,
    cnaesSecundarios: (e.atividades_secundarias ?? [])
      .filter((c) => c.subclasse)
      .map((c) => ({ codigo: c.subclasse!, descricao: c.descricao ?? "" })),
    cep: e.cep ?? null,
    endereco: endereco || null,
    cidade: nomeProprio(e.cidade?.nome),
    uf,
    simples: /^sim$/i.test(d.simples?.simples ?? ""),
    mei: /^sim$/i.test(d.simples?.mei ?? ""),
    socios: (d.socios ?? [])
      .filter((s) => s.nome)
      .map((s) => ({
        nome: nomeProprio(s.nome)!,
        cargo: s.qualificacao_socio?.descricao ?? null,
        responsavelLegal: /administrador/i.test(s.qualificacao_socio?.descricao ?? ""),
      })),
    inscricaoEstadual: ie?.inscricao_estadual ?? null,
    fonte: "cnpjws",
  };
}

type Tentativa = { dados: DadosReceita } | { status: 404 | 502 };

async function tentar(url: string, ler: (json: any) => DadosReceita): Promise<Tentativa> {
  try {
    // Sem User-Agent a BrasilAPI responde 403.
    const r = await fetch(url, { headers: CABECALHOS, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return { status: 404 };
    if (!r.ok) return { status: 502 };
    return { dados: ler(await r.json()) };
  } catch {
    return { status: 502 };
  }
}

/**
 * `comIe`: quando a BrasilAPI responde, ainda busca a IE no CNPJ.ws (usado na
 * tela, uma consulta por vez; o preenchimento automático tira a IE dos XMLs).
 */
export async function consultarReceita(cnpj: string, { comIe = false } = {}): Promise<DadosReceita> {
  const brasil = await tentar(`${URL_BRASILAPI}${cnpj}`, deBrasilApi);
  if ("dados" in brasil) {
    if (comIe) {
      const ws = await tentar(`${URL_CNPJWS}${cnpj}`, deCnpjWs);
      if ("dados" in ws) brasil.dados.inscricaoEstadual = ws.dados.inscricaoEstadual;
    }
    return brasil.dados;
  }
  const ws = await tentar(`${URL_CNPJWS}${cnpj}`, deCnpjWs);
  if ("dados" in ws) return ws.dados;
  if (brasil.status === 404 && ws.status === 404) throw new ErroReceita("CNPJ não encontrado na Receita", 404);
  throw new ErroReceita("Consulta à Receita indisponível agora. Preencha os dados à mão.", 502);
}
