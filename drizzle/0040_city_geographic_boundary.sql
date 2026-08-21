ALTER TABLE "cities" ADD COLUMN "boundary" geometry(MultiPolygon,4326);
--> statement-breakpoint
CREATE INDEX "cities_boundary_gix" ON "cities" USING gist ("boundary");
