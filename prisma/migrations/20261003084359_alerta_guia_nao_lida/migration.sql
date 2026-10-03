-- CreateTable
CREATE TABLE "configuracao_envio" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "dias_alerta_nao_lida" INTEGER[] DEFAULT ARRAY[3, 1]::INTEGER[],
    "prefixo_alerta_nao_lida" TEXT NOT NULL DEFAULT '[Guia não visualizada]',
    "aviso_cabecalho" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracao_envio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alertas_nao_lida" (
    "id" TEXT NOT NULL,
    "dias_antes" INTEGER NOT NULL,
    "enviado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erro" TEXT,
    "protocolo_id" TEXT NOT NULL,

    CONSTRAINT "alertas_nao_lida_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "alertas_nao_lida_protocolo_id_dias_antes_key" ON "alertas_nao_lida"("protocolo_id", "dias_antes");

-- AddForeignKey
ALTER TABLE "alertas_nao_lida" ADD CONSTRAINT "alertas_nao_lida_protocolo_id_fkey" FOREIGN KEY ("protocolo_id") REFERENCES "protocolos_entrega"("id") ON DELETE CASCADE ON UPDATE CASCADE;
