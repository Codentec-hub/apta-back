-- CreateEnum
CREATE TYPE "StatusLead" AS ENUM ('NOVO', 'NA_FILA', 'EM_CONVERSA', 'FORA_DO_PERFIL', 'DADOS_COLETADOS', 'AGUARDANDO_CONFIRMACAO', 'AGENDADO', 'SEM_RESPOSTA', 'DESCARTADO');

-- CreateEnum
CREATE TYPE "StatusAgendamento" AS ENUM ('PRE_RESERVADO', 'CONFIRMADO', 'CANCELADO', 'EXPIRADO');

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "telefone" TEXT NOT NULL,
    "email" TEXT,
    "origem" TEXT,
    "observacoes" TEXT,
    "qualificacao" TEXT,
    "status" "StatusLead" NOT NULL DEFAULT 'NOVO',
    "perfil" JSONB,
    "motivo_encerramento" TEXT,
    "na_fila_em" TIMESTAMP(3),
    "primeira_mensagem_em" TIMESTAMP(3),
    "lembrete_enviado_em" TIMESTAMP(3),
    "ultima_resposta_em" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "cadastrado_por_id" TEXT,
    "conversa_id" TEXT,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disponibilidades_agenda" (
    "id" TEXT NOT NULL,
    "dia_semana" INTEGER NOT NULL,
    "inicio" TEXT NOT NULL,
    "fim" TEXT NOT NULL,
    "duracao_min" INTEGER NOT NULL DEFAULT 30,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "responsavel_id" TEXT,

    CONSTRAINT "disponibilidades_agenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bloqueios_agenda" (
    "id" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bloqueios_agenda_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agendamentos" (
    "id" TEXT NOT NULL,
    "inicio" TIMESTAMP(3) NOT NULL,
    "fim" TIMESTAMP(3) NOT NULL,
    "status" "StatusAgendamento" NOT NULL DEFAULT 'PRE_RESERVADO',
    "expira_em" TIMESTAMP(3),
    "confirmado_em" TIMESTAMP(3),
    "cancelado_em" TIMESTAMP(3),
    "motivo_cancelamento" TEXT,
    "observacoes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" TEXT NOT NULL,
    "confirmado_por_id" TEXT,

    CONSTRAINT "agendamentos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracao_leads" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "disparo_ativo" BOOLEAN NOT NULL DEFAULT true,
    "disparo_automatico" BOOLEAN NOT NULL DEFAULT false,
    "intervalo_min_min" INTEGER NOT NULL DEFAULT 3,
    "intervalo_max_min" INTEGER NOT NULL DEFAULT 8,
    "teto_diario" INTEGER NOT NULL DEFAULT 25,
    "hora_inicio" TEXT NOT NULL DEFAULT '08:00',
    "hora_fim" TEXT NOT NULL DEFAULT '19:00',
    "dias_semana" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5, 6]::INTEGER[],
    "lembrete_horas" INTEGER NOT NULL DEFAULT 24,
    "prazo_pre_reserva_horas" INTEGER NOT NULL DEFAULT 24,
    "antecedencia_min_horas" INTEGER NOT NULL DEFAULT 2,
    "dias_agenda_aberta" INTEGER NOT NULL DEFAULT 14,
    "nome_indicador" TEXT NOT NULL DEFAULT 'Rafael',
    "mensagens_iniciais" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mensagem_lembrete" TEXT,
    "enviar_confirmacao" BOOLEAN NOT NULL DEFAULT true,
    "mensagem_confirmacao" TEXT,
    "formato_atendimento" TEXT NOT NULL DEFAULT 'por videochamada',
    "notificar_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "proximo_disparo_em" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,
    "agente_id" TEXT,

    CONSTRAINT "configuracao_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "leads_telefone_key" ON "leads"("telefone");

-- CreateIndex
CREATE UNIQUE INDEX "leads_conversa_id_key" ON "leads"("conversa_id");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_na_fila_em_idx" ON "leads"("na_fila_em");

-- CreateIndex
CREATE INDEX "bloqueios_agenda_inicio_idx" ON "bloqueios_agenda"("inicio");

-- CreateIndex
CREATE INDEX "agendamentos_inicio_idx" ON "agendamentos"("inicio");

-- CreateIndex
CREATE INDEX "agendamentos_status_idx" ON "agendamentos"("status");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_cadastrado_por_id_fkey" FOREIGN KEY ("cadastrado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_conversa_id_fkey" FOREIGN KEY ("conversa_id") REFERENCES "conversas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disponibilidades_agenda" ADD CONSTRAINT "disponibilidades_agenda_responsavel_id_fkey" FOREIGN KEY ("responsavel_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agendamentos" ADD CONSTRAINT "agendamentos_confirmado_por_id_fkey" FOREIGN KEY ("confirmado_por_id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Dois leads nunca no mesmo horário: só um agendamento ativo por início.
CREATE UNIQUE INDEX "agendamentos_inicio_ativo_key" ON "agendamentos"("inicio") WHERE "status" IN ('PRE_RESERVADO', 'CONFIRMADO');
