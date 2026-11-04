// Lista as empresas/certificados cadastrados na conta SIEG da Apta
// (endpoint "Listar Certificados e Empresas": GET /api/v1/listar).
//
// Autenticação dupla, como a doc pede: Authorization = JWT do sistema
// (Fase A) e X-OAuth-Token = token da conta (Fase B).
//
// Comportamento REAL da API (diferente da documentação, visto em produção
// em 04/11/2026):
//  - `active=false` NÃO traz "ativos e inativos": traz só os inativos/
//    excluídos. Os certificados em uso vêm com `active=true`. Por isso
//    buscamos as duas listas: primeiro as ativas (o que importa), depois as
//    inativas (só para consulta).
//  - Depois da última página o SIEG não devolve lista vazia: responde 404
//    "Nenhum certificado encontrado" ou até 500 "Erro interno". Os dois, a
//    partir da 2ª página, são tratados como fim da lista.
//
// A lista vem paginada (pagina começa em 0) e o SIEG tem limite de
// requisições por minuto. Por isso a busca roda em segundo plano, página a
// página, guarda o resultado em memória e a tela só lê o que já veio --
// assim uma espera por rate limit nunca trava a requisição HTTP da tela.
import { obterTokenSistema } from "./auth.js";
import { obterTokenOAuth } from "./oauth.js";

const URL_LISTAR = "https://api.sieg.com/api/v1/listar";
const MAX_PAGINAS = 100;
const ESPERA_RATE_LIMIT_MS = 31_000;
const MAX_ESPERAS = 6;

export interface EmpresaSieg {
  id: string;
  nome: string;
  documento: string; // só dígitos
  ufCertificado: number | null;
  certificadoExpiraEm: string | null;
  consultaNoturna: boolean;
  ativo: boolean;
  deletado: boolean;
}

export interface EstadoSincronizacao {
  situacao: "nunca" | "andamento" | "concluida" | "erro";
  /** Avisos que não impedem o uso da lista (ex.: inativas não carregaram). */
  avisos: string[];
  iniciadaEm: string | null;
  concluidaEm: string | null;
  paginasLidas: number;
  aguardandoLimiteAte: string | null;
  erro: string | null;
  empresas: EmpresaSieg[];
}

let estado: EstadoSincronizacao = {
  situacao: "nunca",
  iniciadaEm: null,
  concluidaEm: null,
  paginasLidas: 0,
  aguardandoLimiteAte: null,
  erro: null,
  avisos: [],
  empresas: [],
};

export function estadoEmpresasSieg(): EstadoSincronizacao {
  return estado;
}

interface ItemSieg {
  Id?: string;
  Nome?: string;
  CnpjCpf?: string;
  UfCertificado?: number;
  DataExpira?: string;
  ConsultaNoturna?: boolean;
  Ativo?: boolean;
  Deletado?: boolean;
}

interface EnvelopeListar {
  IsSuccess?: boolean;
  IsFailure?: boolean;
  ErrorMessage?: string;
  Data?: ItemSieg[] | null;
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

class LimiteAtingido extends Error {}
/** Erro do SIEG ao pedir uma página (status guardado para decidir se é fim da lista). */
class ErroPagina extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
  ) {
    super(mensagem);
  }
}

async function buscarPagina(ativos: boolean, pagina: number): Promise<ItemSieg[]> {
  const [jwt, oauth] = await Promise.all([obterTokenSistema(), obterTokenOAuth()]);
  const url = `${URL_LISTAR}?active=${ativos}&pagina=${pagina}`;

  let resposta: globalThis.Response;
  try {
    resposta = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${jwt}`, "X-OAuth-Token": oauth, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Não foi possível falar com o SIEG: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (resposta.status === 429) throw new LimiteAtingido("Limite de requisições do SIEG");

  const texto = await resposta.text();
  let corpo: EnvelopeListar | ItemSieg[] | undefined;
  try {
    corpo = JSON.parse(texto) as EnvelopeListar | ItemSieg[];
  } catch {
    corpo = undefined;
  }

  if (!resposta.ok) {
    const motivo = (!Array.isArray(corpo) && corpo?.ErrorMessage) || texto.slice(0, 300) || "sem detalhes";
    // O SIEG não devolve lista vazia depois da última página: responde
    // HTTP 404 "Nenhum certificado encontrado". Isso é o fim da lista (ou uma
    // conta sem certificados, na página 0), não um erro.
    if (resposta.status === 404 && /nenhum certificado/i.test(motivo)) return [];
    if (/limit|muitas|too many/i.test(motivo)) throw new LimiteAtingido(motivo);
    if (resposta.status === 401 || resposta.status === 403)
      throw new Error(`SIEG recusou o acesso (HTTP ${resposta.status}): ${motivo}. Confira se a autorização OAuth ainda vale.`);
    throw new ErroPagina(`SIEG respondeu HTTP ${resposta.status}: ${motivo}`, resposta.status);
  }
  if (!corpo) throw new Error(`SIEG devolveu uma resposta que não é JSON: ${texto.slice(0, 200)}`);
  // Aceita o envelope documentado e, por garantia, um array puro.
  if (Array.isArray(corpo)) return corpo;
  if (corpo.IsFailure || corpo.IsSuccess === false) {
    const motivo = corpo.ErrorMessage || "SIEG recusou a listagem";
    if (/limit|muitas|too many/i.test(motivo)) throw new LimiteAtingido(motivo);
    throw new Error(motivo);
  }
  return corpo.Data ?? [];
}

function normalizar(item: ItemSieg): EmpresaSieg {
  return {
    id: String(item.Id ?? ""),
    nome: String(item.Nome ?? "").trim(),
    documento: String(item.CnpjCpf ?? "").replace(/\D/g, ""),
    ufCertificado: typeof item.UfCertificado === "number" ? item.UfCertificado : null,
    certificadoExpiraEm: item.DataExpira ?? null,
    consultaNoturna: Boolean(item.ConsultaNoturna),
    ativo: Boolean(item.Ativo),
    deletado: Boolean(item.Deletado),
  };
}

/**
 * Lê todas as páginas de uma lista (ativas ou inativas) e devolve as
 * empresas, chamando `aoLer` a cada página para a tela acompanhar.
 */
async function lerLista(
  ativos: boolean,
  aoLer: (empresas: EmpresaSieg[], pagina: number) => void,
): Promise<{ empresas: EmpresaSieg[]; fimPresumido: boolean }> {
  const coletadas = new Map<string, EmpresaSieg>();
  let esperas = 0;
  let tentativasErro = 0;
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    let itens: ItemSieg[];
    try {
      itens = await buscarPagina(ativos, pagina);
      tentativasErro = 0;
    } catch (error) {
      if (error instanceof LimiteAtingido && esperas < MAX_ESPERAS) {
        esperas++;
        estado = { ...estado, aguardandoLimiteAte: new Date(Date.now() + ESPERA_RATE_LIMIT_MS).toISOString() };
        await esperar(ESPERA_RATE_LIMIT_MS);
        estado = { ...estado, aguardandoLimiteAte: null };
        pagina--;
        continue;
      }
      // Erro 5xx: tenta a mesma página mais uma vez antes de decidir.
      if (error instanceof ErroPagina && error.status >= 500 && tentativasErro < 1) {
        tentativasErro++;
        await esperar(5_000);
        pagina--;
        continue;
      }
      // Depois de já ter lido páginas, o SIEG responde erro em vez de lista
      // vazia quando acabou: consideramos o fim da lista.
      if (error instanceof ErroPagina && pagina > 0 && coletadas.size > 0) {
        return { empresas: [...coletadas.values()], fimPresumido: error.status !== 404 };
      }
      throw error;
    }
    if (itens.length === 0) break;
    const antes = coletadas.size;
    for (const item of itens) {
      const empresa = normalizar(item);
      coletadas.set(empresa.id || empresa.documento, empresa);
    }
    aoLer([...coletadas.values()], pagina + 1);
    // Página que não trouxe nada novo = a API ignorou a paginação; para.
    if (coletadas.size === antes) break;
  }
  return { empresas: [...coletadas.values()], fimPresumido: false };
}

async function sincronizar(): Promise<void> {
  let ativas: EmpresaSieg[] = [];
  let paginas = 0;
  const avisos: string[] = [];
  try {
    const lista = await lerLista(true, (empresas, pagina) => {
      paginas = pagina;
      estado = { ...estado, paginasLidas: paginas, empresas };
    });
    ativas = lista.empresas;
    if (lista.fimPresumido)
      avisos.push(
        `O SIEG respondeu erro ao pedir a página ${paginas + 1} das empresas ativas; tratamos como fim da lista (${ativas.length} empresas). Se faltar alguma, clique em “Atualizar do SIEG”.`,
      );
    estado = { ...estado, empresas: ativas };
  } catch (error) {
    estado = {
      ...estado,
      situacao: "erro",
      aguardandoLimiteAte: null,
      erro: error instanceof Error ? error.message : String(error),
      empresas: ativas.length ? ativas : estado.empresas,
    };
    return;
  }

  // Inativas/excluídas: só para consulta. Se falhar, a lista ativa continua valendo.
  let inativas: EmpresaSieg[] = [];
  try {
    const lista = await lerLista(false, (empresas, pagina) => {
      estado = { ...estado, paginasLidas: paginas + pagina, empresas: [...ativas, ...empresas] };
    });
    inativas = lista.empresas;
  } catch (error) {
    avisos.push(
      `As empresas inativas/excluídas não carregaram (${error instanceof Error ? error.message : String(error)}). As ativas estão completas.`,
    );
  }

  const idsAtivos = new Set(ativas.map((e) => e.id || e.documento));
  estado = {
    ...estado,
    situacao: "concluida",
    concluidaEm: new Date().toISOString(),
    aguardandoLimiteAte: null,
    avisos,
    empresas: [...ativas, ...inativas.filter((e) => !idsAtivos.has(e.id || e.documento))],
  };
}

/** Dispara a busca em segundo plano (ignora se já houver uma em andamento). */
export function iniciarSincronizacaoEmpresas(): EstadoSincronizacao {
  if (estado.situacao === "andamento") return estado;
  estado = {
    ...estado,
    situacao: "andamento",
    iniciadaEm: new Date().toISOString(),
    concluidaEm: null,
    paginasLidas: 0,
    aguardandoLimiteAte: null,
    erro: null,
    avisos: [],
  };
  void sincronizar();
  return estado;
}
