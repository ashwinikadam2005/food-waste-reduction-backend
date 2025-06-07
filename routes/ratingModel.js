const express = require("express");

module.exports = (db) => {
  const router = express.Router();

  router.post("/donations/rate", async (req, res) => {
    const { donationId, email, rating, review } = req.body;

    if (!donationId || !email || !rating) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      // Find receiver by email
      const [[receiver]] = await db.query("SELECT id FROM receivers WHERE email = ?", [email]);
      if (!receiver) return res.status(404).json({ error: "Receiver not found" });

      // Verify donation exists and belongs to receiver
      const [[donation]] = await db.query("SELECT donor_id, accepted_by FROM donations WHERE id = ?", [donationId]);
      if (!donation) return res.status(404).json({ error: "Donation not found" });
      if (donation.accepted_by !== receiver.id) {
        return res.status(403).json({ error: "Not authorized to rate this donation" });
      }

      // Insert or update rating
      await db.query(
        `INSERT INTO ratings (donation_id, receiver_id, donor_id, rating, review)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE rating = VALUES(rating), review = VALUES(review), created_at = NOW()`,
        [donationId, receiver.id, donation.donor_id, rating, review || null]
      );

      res.json({ message: "Rating submitted successfully" });
    } catch (err) {
      console.error("Error submitting rating:", err);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  
router.get("/donor-profile/:donorId", async (req, res) => {
  const donorId = req.params.donorId;

  try {
    // Fetch donor details
    const [donor] = await db.execute(
      `SELECT id, organization_name, email, phone, address FROM donor WHERE id = ?`,
      [donorId]
    );

    if (!donor.length) {
      return res.status(404).json({ error: "Donor not found" });
    }

    // Fetch ratings and reviews for this donor
    const [ratings] = await db.execute(
      `SELECT r.rating, r.review, r.created_at, r.receiver_id, rec.organization_name AS receiver_name
       FROM ratings r
       JOIN receivers rec ON r.receiver_id = rec.id
       WHERE r.donor_id = ?`,
      [donorId]
    );

    // Combine donor details with ratings
    const donorProfile = {
      ...donor[0],
      ratings: ratings.map(r => ({
        rating: r.rating,
        review: r.review,
        created_at: r.created_at,
        receiver_name: r.receiver_name,
      })),
    };

    res.json(donorProfile);
  } catch (err) {
    console.error("Error fetching donor profile:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});
  return router;
};
