-- CreateTable
CREATE TABLE "TruckRefueling" (
    "id" TEXT NOT NULL,
    "truckId" TEXT NOT NULL,
    "tripId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "photoUrl" TEXT NOT NULL,
    "currentKm" INTEGER NOT NULL,
    "referenceKm" INTEGER NOT NULL,
    "liters" DOUBLE PRECISION NOT NULL,
    "amountPaid" DOUBLE PRECISION NOT NULL,
    "pricePerLiter" DOUBLE PRECISION,
    "kmPerLiter" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TruckRefueling_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "TruckRefueling" ADD CONSTRAINT "TruckRefueling_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "Truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckRefueling" ADD CONSTRAINT "TruckRefueling_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "TruckTrip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TruckRefueling" ADD CONSTRAINT "TruckRefueling_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
