// Consulta de CNPJ na Receita (BrasilAPI) para a tela de cadastro.
// Passa pelo backend para normalizar os dados e não depender de CORS.
import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { autenticar } from "../middleware/autenticar.js";
import { prisma } from "../prisma.js";
import { consultarReceita, ErroReceita } from "../clientes/receita.js";

export const consultaCnpjRouter = Router();

consultaCnpjRouter.use(autenticar);

consultaCnpjRouter.get("/consulta-cnpj/:cnpj", asyncHandler(async (req, res) => {
  const cnpj = req.params.cnpj.replace(/\D/g, "");
  if (cnpj.length !== 14) {
    res.status(400).json({ erro: "CNPJ deve ter 14 dígitos" });
    return;
  }

  const jaCadastrado = await prisma.cliente.findUnique({
    where: { cnpj },
    select: { id: true, razaoSocial: true, codigo: true },
  });

  try {
    res.json({ jaCadastrado, ...(await consultarReceita(cnpj)) });
  } catch (error) {
    if (error instanceof ErroReceita) {
      res.status(error.status).json({ erro: error.message });
      return;
    }
    throw error;
  }
}));
