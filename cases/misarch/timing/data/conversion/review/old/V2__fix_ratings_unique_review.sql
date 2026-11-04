-- Defect fixes (docs/fixes/review.md).
-- Q1: updateReview stored the rating FOUR_STARS as 'FourStarst', which made the review unreadable; repair such rows.
UPDATE reviews SET rating = 'FourStars' WHERE rating = 'FourStarst';

-- One review per (user, product variant): the check-then-insert in createReview could race. Keep the oldest review
-- of any duplicate pair written by an earlier version, then enforce uniqueness.
DELETE FROM reviews r
    USING reviews o
    WHERE r.user_id = o.user_id
      AND r.product_variant_id = o.product_variant_id
      AND (o.created_at, o.id) < (r.created_at, r.id);
CREATE UNIQUE INDEX reviews_user_id_product_variant_id_key ON reviews (user_id, product_variant_id);
