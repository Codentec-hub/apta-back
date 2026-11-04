// Lista as empresas/certificados cadastrados na conta SIEG da Apta
// (endpoint "Listar Certificados e Empresas": GET /api/v1/listar).
//
// Autenticação dupla, como a doc pede: Authorization = JWT do sistema
// (Fase A) e X-OAuth-Token = token da conta (Fase B).
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

async function buscarPagina(pagina: number): Promise<ItemSieg[]> {
  const [jwt, oauth] = await Promise.all([obterTokenSistema(), obterTokenOAuth()]);
  const url = `${URL_LISTAR}?active=false&pagina=${pagina}`;

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
    if (/limit|muitas|too many/i.test(motivo)) throw new LimiteAtingido(motivo);
    if (resposta.status === 401 || resposta.status === 403)
      throw new Error(`SIEG recusou o acesso (HTTP ${resposta.status}): ${motivo}. Confira se a autorização OAuth ainda vale.`);
    throw new Error(`SIEG respondeu HTTP ${resposta.status}: ${motivo}`);
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

async function sincronizar(): Promise<void> {
  const coletadas = new Map<string, EmpresaSieg>();
  let esperas = 0;
  try {
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      let itens: ItemSieg[];
      try {
        itens = await buscarPagina(pagina);
      } catch (error) {
        if (error instanceof LimiteAtingido && esperas < MAX_ESPERAS) {
          esperas++;
          estado = { ...estado, aguardandoLimiteAte: new Date(Date.now() + ESPERA_RATE_LIMIT_MS).toISOString() };
          await esperar(ESPERA_RATE_LIMIT_MS);
          estado = { ...estado, aguardandoLimiteAte: null };
          pagina--; // tenta a mesma página de novo
          continue;
        }
        throw error;
      }
      if (itens.length === 0) break;
      const antes = coletadas.size;
      for (const item of itens) {
        const empresa = normalizar(item);
        coletadas.set(empresa.id || empresa.documento, empresa);
      }
      estado = { ...estado, paginasLidas: pagina + 1, empresas: [...coletadas.values()] };
      // Página que não trouxe nada novo = a API ignorou a paginação; para.
      if (coletadas.size === antes) break;
    }
    estado = {
      ...estado,
      situacao: "concluida",
      concluidaEm: new Date().toISOString(),
      aguardandoLimiteAte: null,
      empresas: [...coletadas.values()],
    };
  } catch (error) {
    estado = {
      ...estado,
      situacao: "erro",
      aguardandoLimiteAte: null,
      erro: error instanceof Error ? error.message : String(error),
      // Mantém o que já tinha vindo (parcial) para a tela não ficar vazia.
      empresas: coletadas.size ? [...coletadas.values()] : estado.empresas,
    };
  }
}

/** Dispara a busca em segundo plano (ignora se já houver uma em andamento). */
export function iniciarSincronizacaoEmpresas(): EstadoSincronizacao {
  if (estado.situacao === "andamento") return estado;
  estado = {
    ...estado,
    situacao: "andamento",
    iniciadaEm: new Date().toISOString(),
    paginasLidas: 0,
    aguardandoLimiteAte: null,
    erro: null,
  };
  void sincronizar();
  return estado;
}
