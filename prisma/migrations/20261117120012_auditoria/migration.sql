-- CreateTable
CREATE TABLE "auditoria" (
    "id" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuario_id" TEXT,
    "usuario_nome" TEXT,
    "ip" TEXT,
    "acao" TEXT NOT NULL,
    "modulo" TEXT NOT NULL,
    "entidade" TEXT,
    "entidade_id" TEXT,
    "descricao" TEXT NOT NULL,
    "cliente_id" TEXT,
    "antes" JSONB,
    "depois" JSONB,

    CONSTRAINT "auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auditoria_criado_em_idx" ON "auditoria"("criado_em");

-- CreateIndex
CREATE INDEX "auditoria_usuario_id_criado_em_idx" ON "auditoria"("usuario_id", "criado_em");

-- CreateIndex
CREATE INDEX "auditoria_cliente_id_criado_em_idx" ON "auditoria"("cliente_id", "criado_em");

-- CreateIndex
CREATE INDEX "auditoria_modulo_criado_em_idx" ON "auditoria"("modulo", "criado_em");
