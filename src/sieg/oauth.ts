// Onboarding OAuth 2.0 do SIEG (Fase B) -- autorização única, da conta Apta
// inteira (confirmado ao vivo na tela de consentimento: não há seletor de
// empresa/CNPJ). O token definitivo resultante fica em `ConfiguracaoSieg`,
// mesmo registro das credenciais de sistema da Fase A.
import { prisma } from "../prisma.js";
import { obterCredenciais } from "./auth.js";

const URL_AUTORIZACAO = "https://app.sieg.com/AuthorizeAccess.aspx";
// Confirmado na página "Demonstração" (Swagger) da doc oficial.
const URL_GENERATE_TOKEN = "https://api.sieg.com/api/v1/oauth/generate-token";
// Confirmado em teste real (02/11/2026): o SIEG recusa o generate-token com
// "URI de redirecionamento não confere" quando mandamos a URL do backend
// aqui. O que está cadastrado de fato no "Sistema Externo" é a URL do
// frontend (confirmado por gravação de tela do próprio redirect do SIEG) --
// é contra ISSO que o generate-token valida, não contra pra onde o
// navegador efetivamente chega depois (o middleware do frontend repassa pro
// backend só depois, já com o fluxo iniciado). Suporte do SIEG segue sem
// responder sobre corrigir o cadastro; enquanto isso, mandamos o valor que
// bate com o cadastro deles.
const URL_REDIRECT_CADASTRADA = "https://app.contabilidadeapta.com.br/login";
// Validade informada pela doc: 30 dias. Guardamos com 1 dia de margem.
const DURACAO_TOKEN_OAUTH_MS = 30 * 24 * 60 * 60 * 1000;
const MARGEM_RENOVACAO_MS = 24 * 60 * 60 * 1000;

export type NivelAcesso = "read" | "write" | "fullAccess";

// Único fluxo de autorização por vez (ação manual e rara) -- guarda o state
// gerado em `ConfiguracaoSieg` (não em memória) até o callback chegar, pra
// sobreviver a um restart/redeploy entre o redirect pro SIEG e a volta do
// usuário, e pra validar contra CSRF.
export async function gerarState(): Promise<string> {
  const state = crypto.randomUUID();
  await prisma.configuracaoSieg.upsert({
    where: { id: 1 },
    create: { id: 1, oauthState: state },
    update: { oauthState: state },
  });
  return state;
}

export function montarUrlAutorizacao(clientId: string, state: string, accessLevel: NivelAcesso): string {
  const params = new URLSearchParams({ clientId, state, accessLevel });
  return `${URL_AUTORIZACAO}?${params.toString()}`;
}

// "em-andamento" = aceita; "sem-fluxo" = não havia autorização iniciada;
// "state-invalido" = state não bate com o gerado.
export async function validarState(state: string | undefined): Promise<"em-andamento" | "sem-fluxo" | "state-invalido"> {
  const config = await prisma.configuracaoSieg.findUnique({ where: { id: 1 } });
  if (!config?.oauthState) return "sem-fluxo";
  if (state !== config.oauthState) return "state-invalido";
  return "em-andamento";
}

export async function limparState(): Promise<void> {
  await prisma.configuracaoSieg.update({ where: { id: 1 }, data: { oauthState: null } });
}

// Envelope comum às rotas OAuth do SIEG (visto na doc oficial, página
// "Demonstração"): IsSuccess/ErrorMessage/StatusCode/Data/IsFailure.
interface EnvelopeResposta {
  IsSuccess?: boolean;
  IsFailure?: boolean;
  ErrorMessage?: string;
  Data?: unknown;
}

export async function trocarTokenTemporario(tokenTemporario: string, state: string): Promise<void> {
  const credenciais = await obterCredenciais();
  if (!credenciais) {
    throw new Error("SIEG não configurado: defina client_id e secret_key antes de autorizar");
  }

  let resposta: globalThis.Response;
  try {
    resposta = await fetch(URL_GENERATE_TOKEN, {
      method: "POST",
      headers: {
        "X-Client-Id": credenciais.clientId,
        "X-Secret-Key": credenciais.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ AccessToken: tokenTemporario, State: state, RedirectUri: URL_REDIRECT_CADASTRADA }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Não foi possível falar com o SIEG: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Lê o corpo mesmo em erro (!ok): o envelope do SIEG traz ErrorMessage
  // explicando a recusa mesmo em HTTP 400 -- descartar o corpo aqui jogava
  // fora o motivo real e só sobrava o status.
  const textoCorpo = await resposta.text();
  let corpo: EnvelopeResposta | undefined;
  try {
    corpo = JSON.parse(textoCorpo) as EnvelopeResposta;
  } catch {
    corpo = undefined;
  }

  if (!resposta.ok) {
    const motivo = corpo?.ErrorMessage || textoCorpo || "sem detalhes";
    throw new Error(`SIEG recusou a troca do token temporário (HTTP ${resposta.status}): ${motivo}`);
  }
  if (!corpo) {
    throw new Error(`SIEG devolveu uma resposta que não é JSON válido: ${textoCorpo}`);
  }
  if (corpo.IsFailure || corpo.IsSuccess === false) {
    throw new Error(corpo.ErrorMessage || "SIEG recusou a troca do token temporário");
  }

  // O schema da doc só declara `Data: object`, sem detalhar os campos --
  // tenta os nomes mais prováveis (mesmo padrão de capitalização da API).
  const dados = corpo.Data as { Token?: string; AccessToken?: string; access_token?: string } | undefined;
  const token = dados?.Token ?? dados?.AccessToken ?? dados?.access_token;
  if (!token) {
    throw new Error("SIEG não devolveu um token definitivo em Data na resposta de generate-token");
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
