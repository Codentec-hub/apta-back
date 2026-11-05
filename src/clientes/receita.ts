// Consulta de CNPJ na Receita via BrasilAPI (pública, sem chave), normalizada
// para o cadastro da empresa. Usada pela tela ("Buscar na Receita") e pelo
// preenchimento automático dos cadastros (clientes/completar.ts).

const URL_BRASILAPI = "https://brasilapi.com.br/api/cnpj/v1/";

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
}

export class ErroReceita extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502,
  ) {
    super(message);
  }
}

export async function consultarReceita(cnpj: string): Promise<DadosReceita> {
  let resposta: globalThis.Response;
  try {
    // Sem User-Agent a BrasilAPI responde 403.
    resposta = await fetch(`${URL_BRASILAPI}${cnpj}`, {
      headers: { "User-Agent": "SistemaApta/1.0", Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ErroReceita("Consulta à Receita indisponível agora. Preencha os dados à mão.", 502);
  }
  if (resposta.status === 404) throw new ErroReceita("CNPJ não encontrado na Receita", 404);
  if (!resposta.ok) throw new ErroReceita(`Consulta à Receita falhou (${resposta.status}). Preencha os dados à mão.`, 502);
  const d = (await resposta.json()) as RespostaBrasilApi;

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
  };
}
