-- AlterTable
ALTER TABLE "configuracao_envio" ADD COLUMN     "saude_fiscal_automatico" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "saude_fiscal_canais" TEXT[] DEFAULT ARRAY['email', 'whatsapp']::TEXT[],
ADD COLUMN     "saude_fiscal_dia" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "saude_fiscal_ultimo_lote" TEXT;

-- AlterTable
ALTER TABLE "configuracao_sieg" ADD COLUMN     "dia_corte" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "ultima_captura_em" TIMESTAMP(3),
ADD COLUMN     "ultima_captura_resumo" TEXT;

-- AlterTable
ALTER TABLE "sieg_notas" ADD COLUMN     "cancelada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "xml" BYTEA;

-- CreateTable
CREATE TABLE "relatorios_saude_fiscal" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "token" TEXT NOT NULL,
    "mes" TEXT NOT NULL,
    "dados" JSONB NOT NULL,
    "automatico" BOOLEAN NOT NULL DEFAULT false,
    "envios" JSONB NOT NULL DEFAULT '[]',
    "lido_em" TIMESTAMP(3),
    "acessos" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliente_id" TEXT NOT NULL,
    "usuario_id" TEXT,

    CONSTRAINT "relatorios_saude_fiscal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "relatorios_saude_fiscal_numero_key" ON "relatorios_saude_fiscal"("numero");

-- CreateIndex
CREATE UNIQUE INDEX "relatorios_saude_fiscal_token_key" ON "relatorios_saude_fiscal"("token");

-- CreateIndex
CREATE INDEX "relatorios_saude_fiscal_cliente_id_mes_idx" ON "relatorios_saude_fiscal"("cliente_id", "mes");

-- CreateIndex
CREATE INDEX "sieg_notas_documento_empresa_mes_tipo_papel_idx" ON "sieg_notas"("documento_empresa", "mes", "tipo", "papel");

-- AddForeignKey
ALTER TABLE "relatorios_saude_fiscal" ADD CONSTRAINT "relatorios_saude_fiscal_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- CreateTable
CREATE TABLE "pendencias_cliente" (
    "id" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "prazo" DATE,
    "resolvida_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cliente_id" TEXT NOT NULL,
    "usuario_id" TEXT,

    CONSTRAINT "pendencias_cliente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pendencias_cliente_cliente_id_idx" ON "pendencias_cliente"("cliente_id");

-- AddForeignKey
ALTER TABLE "pendencias_cliente" ADD CONSTRAINT "pendencias_cliente_cliente_id_fkey" FOREIGN KEY ("cliente_id") REFERENCES "clientes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
