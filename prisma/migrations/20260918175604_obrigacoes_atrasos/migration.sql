-- CreateTable
CREATE TABLE "obrigacoes" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "prazo" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluida_em" TIMESTAMP(3),
    "cliente_id" TEXT NOT NULL,
    "setor_id" TEXT NOT NULL,
    "responsavel_id" TEXT,

    CONSTRAINT "obrigacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "atrasos" (
    "id" TEXT NOT NULL,
    "obrigacao_id" TEXT NOT NULL,
    "justificativa" TEXT NOT NULL,
    "causa_raiz" TEXT NOT NULL,
    "plano_de_acao" TEXT NOT NULL,
    "prazo_prometido" TIMESTAMP(3) NOT NULL,
    "cumprido" BOOLEAN NOT NULL DEFAULT false,
    "cumprido_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "atrasos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "atrasos_obrigacao_id_key" ON "atrasos"("obrigacao_id");

-- AddForeignKey
ALTER TABLE "obrigacoes" ADD CONSTRAINT "obrigacoes_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obrigacoes" ADD CONSTRAINT "obrigacoes_setor_id_fkey" FOREIGN KEY ("setor_id") REFERENCES "setores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "obrigacoes" ADD CONSTRAINT "obrigacoes_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "atrasos" ADD CONSTRAINT "atrasos_obrigacao_id_fkey" FOREIGN KEY ("obrigacao_id") REFERENCES "obrigacoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
