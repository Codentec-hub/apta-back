-- CreateTable
CREATE TABLE "notificacoes" (
    "id" TEXT NOT NULL,
    "usuario_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "categoria" TEXT NOT NULL,
    "severidade" TEXT NOT NULL DEFAULT 'info',
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "href" TEXT,
    "chave" TEXT,
    "dados" JSONB,
    "lida_em" TIMESTAMP(3),
    "arquivada_em" TIMESTAMP(3),
    "email_enviado_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificacoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preferencias_notificacao" (
    "usuario_id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "app" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "preferencias_notificacao_pkey" PRIMARY KEY ("usuario_id","tipo")
);

-- CreateIndex
CREATE INDEX "notificacoes_usuario_id_arquivada_em_criado_em_idx" ON "notificacoes"("usuario_id", "arquivada_em", "criado_em");

-- CreateIndex
CREATE INDEX "notificacoes_usuario_id_lida_em_idx" ON "notificacoes"("usuario_id", "lida_em");

-- CreateIndex
CREATE UNIQUE INDEX "notificacoes_usuario_id_chave_key" ON "notificacoes"("usuario_id", "chave");

-- AddForeignKey
ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preferencias_notificacao" ADD CONSTRAINT "preferencias_notificacao_usuario_id_fkey" FOREIGN KEY ("usuario_id") REFERENCES "usuarios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
