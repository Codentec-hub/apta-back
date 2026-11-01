// Onboarding OAuth 2.0 do SIEG (Fase B) -- autorização única, da conta Apta
// inteira (confirmado ao vivo na tela de consentimento: não há seletor de
// empresa/CNPJ). O token definitivo resultante fica em `ConfiguracaoSieg`,
// mesmo registro das credenciais de sistema da Fase A.
import { prisma } from "../prisma.js";
import { obterTokenSistema } from "./auth.js";

const URL_AUTORIZACAO = "https://app.sieg.com/AuthorizeAccess.aspx";
// Assumido por convenção com create-jwt (/api/v1/create-jwt) -- a doc oficial
// não detalha o formato exato deste endpoint. A Task 4 (autorização real)
// confirma/corrige isto.
const URL_GENERATE_TOKEN = "https://api.sieg.com/api/v1/generate-token";
// Validade informada pela doc: 30 dias. Guardamos com 1 dia de margem.
const DURACAO_TOKEN_OAUTH_MS = 30 * 24 * 60 * 60 * 1000;
const MARGEM_RENOVACAO_MS = 24 * 60 * 60 * 1000;

export type NivelAcesso = "read" | "write" | "fullAccess";

// Único fluxo de autorização por vez (ação manual e rara) -- guarda o state
// gerado até o callback chegar, pra validar contra CSRF.
let stateEmAndamento: string | null = null;

export function gerarState(): string {
  stateEmAndamento = crypto.randomUUID();
  return stateEmAndamento;
}

export function montarUrlAutorizacao(clientId: string, state: string, accessLevel: NivelAcesso): string {
  const params = new URLSearchParams({ clientId, state, accessLevel });
  return `${URL_AUTORIZACAO}?${params.toString()}`;
}

// "em-andamento" = aceita; "sem-fluxo" = não havia autorização iniciada;
// "state-invalido" = state não bate com o gerado.
export function validarState(state: string | undefined): "em-andamento" | "sem-fluxo" | "state-invalido" {
  if (!stateEmAndamento) return "sem-fluxo";
  if (state !== stateEmAndamento) return "state-invalido";
  return "em-andamento";
}

export function limparState(): void {
  stateEmAndamento = null;
}

export async function trocarTokenTemporario(tokenTemporario: string): Promise<void> {
  const jwtSistema = await obterTokenSistema();

  let resposta: globalThis.Response;
  try {
    resposta = await fetch(URL_GENERATE_TOKEN, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwtSistema}`, "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenTemporario }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Não foi possível falar com o SIEG: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!resposta.ok) {
    throw new Error(`SIEG recusou a troca do token temporário (HTTP ${resposta.status})`);
  }

  // Mesma cautela da Fase A: a doc mostra um formato de resposta, a API às
  // vezes devolve outro (string pura em vez de objeto). Aceita os dois.
  const corpo = (await resposta.json()) as unknown;
  const token = typeof corpo === "string" ? corpo : (corpo as { Token?: string; token?: string })?.Token
    ?? (corpo as { token?: string })?.token;
  if (!token) {
    throw new Error("SIEG não devolveu um token definitivo na resposta de generate-token");
  }

  await prisma.configuracaoSieg.upsert({
    where: { id: 1 },
    create: { id: 1, oauthToken: token, oauthExpiraEm: new Date(Date.now() + DURACAO_TOKEN_OAUTH_MS - MARGEM_RENOVACAO_MS) },
    update: { oauthToken: token, oauthExpiraEm: new Date(Date.now() + DURACAO_TOKEN_OAUTH_MS - MARGEM_RENOVACAO_MS) },
  });
}

// Sem auto-renovação aqui -- isso é a Fase C. Lança erro pedindo
// reautorização se o token estiver ausente ou vencido.
export async function obterTokenOAuth(): Promise<string> {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  if (!config?.oauthToken || !config.oauthExpiraEm || config.oauthExpiraEm.getTime() <= Date.now()) {
    throw new Error("Token OAuth do SIEG ausente ou expirado -- autorize novamente em /sieg/oauth/autorizar");
  }
  return config.oauthToken;
}
