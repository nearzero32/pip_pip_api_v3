CREATE OR REPLACE FUNCTION enforce_delivery_pricing_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.city_id <> OLD.city_id OR NEW.version <> OLD.version
    OR NEW.base_fee <> OLD.base_fee OR NEW.included_distance_meters <> OLD.included_distance_meters
    OR NEW.price_per_km <> OLD.price_per_km OR NEW.rounding_step <> OLD.rounding_step
    OR NEW.maximum_delivery_distance_meters IS DISTINCT FROM OLD.maximum_delivery_distance_meters
    OR NEW.routing_fallback_enabled <> OLD.routing_fallback_enabled
    OR NEW.fallback_on_no_route <> OLD.fallback_on_no_route
    OR NEW.fallback_on_provider_failure <> OLD.fallback_on_provider_failure
    OR NEW.fallback_extra_distance_meters <> OLD.fallback_extra_distance_meters
    OR NEW.created_by_account_id <> OLD.created_by_account_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'delivery pricing values are immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD.status = 'DRAFT' AND NEW.status = 'ACTIVE' AND NEW.activated_at IS NOT NULL AND NEW.deactivated_at IS NULL AND NEW.activation_revision IS NOT NULL)
    OR (OLD.status = 'INACTIVE' AND NEW.status = 'ACTIVE' AND NEW.activated_at IS NOT NULL AND NEW.deactivated_at IS NULL AND NEW.activation_revision IS NOT NULL)
    OR (OLD.status = 'ACTIVE' AND NEW.status = 'INACTIVE' AND NEW.activated_at = OLD.activated_at AND NEW.deactivated_at IS NOT NULL AND NEW.activation_revision = OLD.activation_revision)
  ) THEN
    RAISE EXCEPTION 'invalid delivery pricing lifecycle transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
