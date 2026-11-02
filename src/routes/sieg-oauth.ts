// Onboarding OAuth do SIEG (Fase B): inicia a autorização e recebe o
// callback. O callback é público -- o navegador chega aqui direto do SIEG,
// sem o Authorization da nossa própria API -- protegido pelo `state`.
import type { Request } from "express";
import { Router } from "express";
import { verificarToken } from "../auth.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { credenciaisConfiguradas, obterCredenciais } from "../sieg/auth.js";
import { gerarState, limparState, montarUrlAutorizacao, trocarTokenTemporario, validarState } from "../sieg/oauth.js";

export const siegOauthRouter = Router();

function paginaResultado(mensagem: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Autorização SIEG</title></head><body style="font-family: sans-serif; padding: 2rem;"><p>${mensagem}</p></body></html>`;
}

// Rota navegada direto pelo navegador (pra seguir o redirect até o SIEG), não
// chamada via fetch -- não dá pra mandar o Authorization header. Mesmo padrão
// de /eventos: aceita o token também via query string.
siegOauthRouter.get("/sieg/oauth/autorizar", asyncHandler(async (req: Request, res) => {
  const header = req.headers.authorization;
  const tokenHeader = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const tokenQuery = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = tokenHeader ?? tokenQuery;
  if (!token) {
    res.status(401).json({ erro: "Token não informado" });
    return;
  }

  let usuario;
  try {
    usuario = verificarToken(token);
  } catch {
    res.status(401).json({ erro: "Token inválido ou expirado" });
    return;
  }

  if (usuario.perfil !== "ADMIN" && usuario.perfil !== "GESTOR") {
    res.status(403).json({ erro: "Apenas administradores e gestores podem iniciar a autorização" });
    return;
  }
  if (!(await credenciaisConfiguradas())) {
    res.status(400).json({ erro: "Configure client_id e secret_key em Configurações > Integrações antes de autorizar" });
    return;
  }
  const clientId = (await obterCredenciais())?.clientId;
  if (!clientId) {
    res.status(400).json({ erro: "client_id do SIEG não configurado" });
    return;
  }
  const state = await gerarState();
  res.redirect(montarUrlAutorizacao(clientId, state, "read"));
}));

siegOauthRouter.get("/sieg/oauth/callback", asyncHandler(async (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : undefined;
  // Confirmado em teste real (gravação de tela, 02/11/2026): o SIEG manda
  // "accessToken" com "a" minúsculo -- a doc oficial mostra "AccessToken" e
  // estava errada. Aceita os três formatos por garantia.
  const tokenTemporario =
    typeof req.query.accessToken === "string"
      ? req.query.accessToken
      : typeof req.query.AccessToken === "string"
        ? req.query.AccessToken
        : typeof req.query.token === "string"
          ? req.query.token
          : undefined;

  const validacao = await validarState(state);
  if (validacao === "sem-fluxo") {
    res.status(200).send(paginaResultado("Autorização já concluída ou não iniciada por aqui. Pode fechar esta aba."));
    return;
  }
  if (validacao === "state-invalido") {
    res.status(400).send(paginaResultado("Autorização rejeitada: identificador de segurança não confere. Inicie de novo em /sieg/oauth/autorizar."));
    return;
  }
  if (!tokenTemporario) {
    res.status(400).send(paginaResultado("O SIEG não enviou o token de autorização esperado nesta chamada."));
    return;
  }

  try {
    const inicio = Date.now();
    await trocarTokenTemporario(tokenTemporario, state!);
    await limparState();
    console.log(`[sieg] troca de token concluída em ${Date.now() - inicio}ms`);
    res.status(200).send(paginaResultado("Autorização concluída com sucesso! Pode fechar esta aba."));
  } catch (error) {
    console.error("[sieg] falha na troca do token:", error instanceof Error ? error.message : String(error));
    res.status(502).send(paginaResultado(`Falha ao concluir a autorização: ${error instanceof Error ? error.message : String(error)}`));
  }
}));
