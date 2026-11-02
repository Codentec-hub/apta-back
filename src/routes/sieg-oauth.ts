// Onboarding OAuth do SIEG (Fase B): inicia a autorização e recebe o
// callback. O callback é público -- o navegador chega aqui direto do SIEG,
// sem o Authorization da nossa própria API -- protegido pelo `state`.
import type { Request } from "express";
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { credenciaisConfiguradas, obterCredenciais } from "../sieg/auth.js";
import { gerarState, limparState, montarUrlAutorizacao, trocarTokenTemporario, validarState } from "../sieg/oauth.js";

export const siegOauthRouter = Router();

function podeAlterar(req: Request): boolean {
  return req.usuario?.perfil === "ADMIN" || req.usuario?.perfil === "GESTOR";
}

function paginaResultado(mensagem: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Autorização SIEG</title></head><body style="font-family: sans-serif; padding: 2rem;"><p>${mensagem}</p></body></html>`;
}

siegOauthRouter.get("/sieg/oauth/autorizar", autenticar, asyncHandler(async (req, res) => {
  if (!podeAlterar(req)) {
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
  // "AccessToken" é o nome do campo usado pela doc oficial no corpo do
  // generate-token -- assume-se o mesmo nome na query do callback. "token"
  // fica como fallback caso o SIEG use um nome diferente na prática.
  const tokenTemporario =
    typeof req.query.AccessToken === "string"
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
    await trocarTokenTemporario(tokenTemporario, state!);
    await limparState();
    res.status(200).send(paginaResultado("Autorização concluída com sucesso! Pode fechar esta aba."));
  } catch (error) {
    res.status(502).send(paginaResultado(`Falha ao concluir a autorização: ${error instanceof Error ? error.message : String(error)}`));
  }
}));
