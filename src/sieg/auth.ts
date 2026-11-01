// Autenticação de sistema com o SIEG (JWT do integrador "Apta"), separada da
// autorização por cliente (OAuth, que vem na Fase B). Credenciais na tabela
// `ConfiguracaoSieg` têm prioridade sobre SIEG_CLIENT_ID/SIEG_SECRET_KEY do
// ambiente, igual ao padrão de Gemini/Evolution.
import { prisma } from "../prisma.js";

const CREATE_JWT_URL = "https://api.sieg.com/api/v1/create-jwt";
// O JWT dura 24h; renovamos com 1h de margem pra nunca usar um token vencido
// no meio de uma chamada (e pra não gastar cota do rate limit — 2 req/min
// somando todos os clientes — perto do vencimento exato).
const MARGEM_RENOVACAO_MS = 60 * 60 * 1000;
const DURACAO_TOKEN_MS = 24 * 60 * 60 * 1000;

interface Credenciais {
  clientId: string;
  secretKey: string;
}

let cache: { token: string; expiraEm: number } | null = null;
// Evita duas chamadas simultâneas a create-jwt quando não há cache ainda.
let emAndamento: Promise<string> | null = null;

async function obterCredenciais(): Promise<Credenciais | null> {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  const clientId = config?.clientId || process.env.SIEG_CLIENT_ID;
  const secretKey = config?.secretKey || process.env.SIEG_SECRET_KEY;
  if (!clientId || !secretKey) return null;
  return { clientId, secretKey };
}

export async function credenciaisConfiguradas(): Promise<boolean> {
  return (await obterCredenciais()) !== null;
}

// Usado pela Fase B (src/sieg/oauth.ts) pra montar a URL de autorização sem
// duplicar a regra de precedência banco/ambiente de `obterCredenciais`.
export async function obterClientId(): Promise<string | null> {
  return (await obterCredenciais())?.clientId ?? null;
}

async function buscarNovoToken(): Promise<string> {
  const credenciais = await obterCredenciais();
  if (!credenciais) {
    throw new Error(
      "SIEG não configurado: defina client_id e secret_key em Configurações > Integrações ou nas variáveis SIEG_CLIENT_ID/SIEG_SECRET_KEY",
    );
  }

  let resposta: globalThis.Response;
  try {
    resposta = await fetch(CREATE_JWT_URL, {
      method: "POST",
      headers: { "X-Client-Id": credenciais.clientId, "X-Secret-Key": credenciais.secretKey },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Não foi possível falar com o SIEG: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!resposta.ok) {
    throw new Error(`SIEG recusou a autenticação (HTTP ${resposta.status})`);
  }

  // A documentação oficial mostra a resposta como `{"Token": "..."}`, mas a
  // API real devolve o JWT como uma string JSON pura — aceita os dois.
  const corpo = (await resposta.json()) as unknown;
  const token = typeof corpo === "string" ? corpo : (corpo as { Token?: string })?.Token;
  if (!token) {
    throw new Error("SIEG não devolveu um Token na resposta de create-jwt");
  }

  cache = { token, expiraEm: Date.now() + DURACAO_TOKEN_MS - MARGEM_RENOVACAO_MS };
  return token;
}

export async function obterTokenSistema(): Promise<string> {
  if (cache && cache.expiraEm > Date.now()) return cache.token;
  if (emAndamento) return emAndamento;

  emAndamento = buscarNovoToken().finally(() => {
    emAndamento = null;
  });
  return emAndamento;
}

// Chamado pela rota de configuração ao salvar client_id/secret_key novos —
// sem isso, um token obtido com a credencial antiga continuaria valendo por
// até ~23h depois da troca, e /configuracoes/sieg/status reportaria "ok"
// testando o token em cache em vez da credencial recém-salva.
export function invalidarCache(): void {
  cache = null;
}
