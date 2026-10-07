-- Agendamento de motorista: local de retirada e de entrega do veiculo (planilha de
-- agendamento diario dos motoristas). Opcionais.
ALTER TABLE "Appointment" ADD COLUMN "pickupLocation" TEXT,
ADD COLUMN "dropoffLocation" TEXT;
