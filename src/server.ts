import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { healthRouter } from "./routes/health.js";
import { clientesRouter } from "./routes/clientes.js";
import { authRouter } from "./routes/auth.js";
import { usuariosRouter } from "./routes/usuarios.js";
import { setoresRouter } from "./routes/setores.js";
import { obrigacoesRouter } from "./routes/obrigacoes.js";
import { tiposObrigacaoRouter } from "./routes/tipos-obrigacao.js";
import { cadastroObrigacoesRouter } from "./routes/cadastro-obrigacoes.js";
import { agendarGeracaoAutomatica } from "./obrigacoes/gerar-entregas.js";
import { demandasRouter } from "./routes/demandas.js";
import { atendimentosRouter } from "./routes/atendimentos.js";
import { financeiroRouter } from "./routes/financeiro.js";
import { feriadosRouter } from "./routes/feriados.js";
import { indicadoresRouter } from "./routes/indicadores.js";
import { documentosEntregaRouter, entregaPublicaRouter } from "./routes/documentos-entrega.js";
import { configuracaoEnvioRouter } from "./routes/configuracao-envio.js";
import { agendarAlertasNaoLida } from "./obrigacoes/alerta-nao-lida.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use(healthRouter);
// Link público do protocolo de entrega (sem login) — antes dos routers que
// exigem autenticação para tudo que passa por eles.
app.use(entregaPublicaRouter);
app.use(authRouter);
app.use(usuariosRouter);
app.use(setoresRouter);
app.use(clientesRouter);
app.use(obrigacoesRouter);
app.use(tiposObrigacaoRouter);
app.use(cadastroObrigacoesRouter);
app.use(demandasRouter);
app.use(atendimentosRouter);
app.use(financeiroRouter);
app.use(feriadosRouter);
app.use(indicadoresRouter);
app.use(documentosEntregaRouter);
app.use(configuracaoEnvioRouter);

// Rede de segurança: qualquer erro não tratado numa rota cai aqui em vez de
// derrubar o processo (evita que um erro do Prisma, por exemplo, tire a API
// do ar inteira).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ erro: "Erro interno no servidor" });
});

const port = Number(process.env.PORT ?? 3333);

app.listen(port, () => {
  console.log(`API do Sistema Apta rodando na porta ${port}`);
  agendarGeracaoAutomatica();
  agendarAlertasNaoLida();
});
